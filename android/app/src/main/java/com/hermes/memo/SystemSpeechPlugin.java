package com.hermes.memo;

import android.Manifest;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 系统语音识别插件（Android SpeechRecognizer）
 *
 * 为什么要走原生：Android WebView 里没有 webkitSpeechRecognition（那是 Chrome
 * 浏览器独有），而云端 ASR 又受格式/额度限制。系统识别由设备上的语音服务
 * 完成，实时出字、不消耗 API 额度。
 *
 * 关键点：SpeechRecognizer.createSpeechRecognizer(context) 会使用「系统默认」
 * 识别服务，而很多国产机的默认项其实是 Google 语音服务
 * （com.google.android.googlequicksearchbox）。国内网络连不上 Google，
 * 于是每次识别都返回 ERROR_NETWORK（"系统语音服务网络异常"），
 * 哪怕设备上装了厂商自己的识别服务也用不上。
 *
 * 因此这里显式枚举所有 RecognitionService，按「厂商 > 非 Google > Google」
 * 打分后指定 ComponentName 创建识别器。
 *
 * 前端用法（src/services/system-speech.ts）：
 *   probe()             → { available, services[], googleOnly, selected }
 *   available()         → { available: boolean }
 *   start({ language }) → { text }   // 说完（或调用 stop()）后 resolve
 *   stop() / cancel()
 *   事件：started / partial / result / error
 */
@CapacitorPlugin(
    name = "SystemSpeech",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class SystemSpeechPlugin extends Plugin implements RecognitionListener {

    private static final String TAG = "SystemSpeech";

    /** 厂商识别服务包名关键词（命中则优先） */
    private static final String[] VENDOR_HINTS = {
        "miui", "xiaomi", "huawei", "hihonor", "honor", "vivo", "oppo", "coloros",
        "oneplus", "oplus", "samsung", "meizu", "flyme", "iflytek", "ifly", "baidu",
        "sogou", "nubia", "realme", "transsion", "tecno", "smartisan", "zte", "lenovo",
    };

    private SpeechRecognizer recognizer;
    private ComponentName recognizerComponent;
    private PluginCall pendingCall;
    private String language = "zh-CN";
    private String currentService = "";

    // ── 识别服务探测 ──

    private static class ServiceEntry {
        String packageName;
        String className;
        String label;
        boolean google;
        boolean system;
        int score;
    }

    private boolean isGoogleService(String pkg) {
        if (pkg == null) return false;
        return pkg.startsWith("com.google.")
            || pkg.contains("googlequicksearchbox")
            || pkg.contains("android.google")
            || pkg.contains("google.android");
    }

    private boolean isVendorService(String pkg) {
        if (pkg == null) return false;
        String p = pkg.toLowerCase();
        for (String hint : VENDOR_HINTS) {
            if (p.contains(hint)) return true;
        }
        return false;
    }

    private int scoreOf(ServiceEntry e) {
        int s = 0;
        // 非 Google 是首要条件：Google 服务在国内基本不可用
        if (!e.google) s += 100;
        if (isVendorService(e.packageName)) s += 50;
        if (e.system) s += 10;
        return s;
    }

    /** 枚举设备上所有 RecognitionService，按可用性从高到低排序 */
    private List<ServiceEntry> listRecognitionServices() {
        List<ServiceEntry> result = new ArrayList<>();
        try {
            PackageManager pm = getContext().getPackageManager();
            Intent intent = new Intent(RecognitionService.SERVICE_INTERFACE);
            List<ResolveInfo> list;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                list = pm.queryIntentServices(intent, PackageManager.MATCH_ALL);
            } else {
                list = pm.queryIntentServices(intent, 0);
            }
            if (list == null) return result;

            for (ResolveInfo ri : list) {
                ServiceInfo si = ri.serviceInfo;
                if (si == null || si.packageName == null || si.name == null) continue;

                ServiceEntry e = new ServiceEntry();
                e.packageName = si.packageName;
                e.className = si.name;
                try {
                    CharSequence cs = ri.loadLabel(pm);
                    e.label = cs == null ? si.packageName : cs.toString().trim();
                } catch (Exception ex) {
                    e.label = si.packageName;
                }
                if (e.label == null || e.label.isEmpty()) e.label = si.packageName;
                e.system = si.applicationInfo != null
                    && (si.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
                e.google = isGoogleService(si.packageName);
                e.score = scoreOf(e);
                result.add(e);
            }
        } catch (Exception ignored) {
        }
        Collections.sort(result, (a, b) -> Integer.compare(b.score, a.score));
        return result;
    }

    private ServiceEntry pickBest(List<ServiceEntry> list) {
        return list.isEmpty() ? null : list.get(0);
    }

    private boolean onlyGoogle(List<ServiceEntry> list) {
        if (list.isEmpty()) return false;
        for (ServiceEntry e : list) {
            if (!e.google) return false;
        }
        return true;
    }

    @PluginMethod
    public void probe(PluginCall call) {
        List<ServiceEntry> list = listRecognitionServices();
        ServiceEntry best = pickBest(list);

        JSArray arr = new JSArray();
        for (ServiceEntry e : list) {
            JSObject o = new JSObject();
            o.put("packageName", e.packageName);
            o.put("className", e.className);
            o.put("label", e.label);
            o.put("google", e.google);
            o.put("system", e.system);
            arr.put(o);
        }

        JSObject ret = new JSObject();
        ret.put("available", !list.isEmpty() || SpeechRecognizer.isRecognitionAvailable(getContext()));
        ret.put("services", arr);
        // 只有 Google 服务 → 国内网络几乎必然 ERROR_NETWORK，前端应直接用云端
        ret.put("googleOnly", onlyGoogle(list));
        ret.put("selected", best == null ? null : best.packageName);
        ret.put("selectedLabel", best == null ? null : best.label);
        call.resolve(ret);
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "onMicPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void onMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            begin(call);
        } else {
            call.reject("麦克风权限被拒绝，请在系统设置里允许「录音」后重试", "PERMISSION_DENIED");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (recognizer != null) {
            try {
                recognizer.stopListening();
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        if (recognizer != null) {
            try {
                recognizer.cancel();
            } catch (Exception ignored) {
            }
        }
        destroyRecognizer();
        rejectPending("已取消", "CANCELLED");
        call.resolve();
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.cancel();
            } catch (Exception ignored) {
            }
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
            }
            recognizer = null;
            recognizerComponent = null;
        }
    }

    private void begin(PluginCall call) {
        List<ServiceEntry> services = listRecognitionServices();
        final ServiceEntry svc = pickBest(services);

        if (svc == null && !SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("设备没有可用的系统语音识别服务", "NO_SERVICE");
            return;
        }

        // 同一时间只允许一个识别会话
        rejectPending("上一次识别还没结束", "BUSY");
        pendingCall = call;
        language = call.getString("language", "zh-CN");
        currentService = svc == null ? "(default)" : svc.packageName;

        if (getActivity() == null) {
            rejectPending("应用不在前台，无法启动语音识别", "NO_ACTIVITY");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                ComponentName want = svc == null
                    ? null
                    : new ComponentName(svc.packageName, svc.className);

                // 每次都重建：识别器在报错后经常处于不可复用状态，
                // 复用它会让下一次 startListening 直接 ERROR_CLIENT。
                if (recognizer != null && !equalsComponent(recognizerComponent, want)) {
                    destroyRecognizer();
                }
                if (recognizer == null) {
                    SpeechRecognizer created = null;
                    if (want != null) {
                        try {
                            created = SpeechRecognizer.createSpeechRecognizer(getContext(), want);
                        } catch (Exception ignored) {
                            created = null;
                        }
                    }
                    if (created == null) {
                        created = SpeechRecognizer.createSpeechRecognizer(getContext());
                        want = null;
                    }
                    recognizer = created;
                    recognizerComponent = want;
                    recognizer.setRecognitionListener(this);
                }

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
                // 说完停顿约 1.2s 自动收尾，避免一直"正在听"
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 800L);
                recognizer.startListening(intent);
            } catch (Exception e) {
                rejectPending("启动系统语音识别失败：" + e.getMessage(), "START_FAILED");
            }
        });
    }

    private boolean equalsComponent(ComponentName a, ComponentName b) {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        return a.equals(b);
    }

    // ── 结果处理 ──

    private String firstResult(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) return "";
        String text = list.get(0);
        return text == null ? "" : text.trim();
    }

    private void resolvePending(JSObject data) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call != null) {
            call.resolve(data);
        }
    }

    private void rejectPending(String message, String code) {
        PluginCall call = pendingCall;
        pendingCall = null;
        if (call != null) {
            call.reject(message, code);
        }
    }

    // ── RecognitionListener ──

    @Override
    public void onReadyForSpeech(Bundle params) {
        notifyListeners("started", new JSObject());
    }

    @Override
    public void onBeginningOfSpeech() {
    }

    @Override
    public void onRmsChanged(float rmsdB) {
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
    }

    @Override
    public void onEndOfSpeech() {
    }

    @Override
    public void onError(int error) {
        String code;
        String message;
        switch (error) {
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                code = "SPEECH_TIMEOUT";
                message = "没有检测到语音，请靠近麦克风再说一次";
                break;
            case SpeechRecognizer.ERROR_NO_MATCH:
                code = "NO_MATCH";
                message = "没有听清，请再说一次";
                break;
            case SpeechRecognizer.ERROR_AUDIO:
                code = "AUDIO";
                message = "录音出错，请重试";
                break;
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                code = "PERMISSION_DENIED";
                message = "缺少录音权限，请在系统设置里允许";
                break;
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                code = "NETWORK";
                message = "系统语音服务连接超时（" + currentService + "）";
                break;
            case SpeechRecognizer.ERROR_NETWORK:
                code = "NETWORK";
                message = "系统语音服务连不上网络（" + currentService + "）";
                break;
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                code = "SERVER";
                message = "系统语音服务返回错误（" + currentService + "）";
                break;
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                code = "BUSY";
                message = "系统语音服务忙，请稍后重试";
                break;
            case SpeechRecognizer.ERROR_CLIENT:
                code = "CLIENT";
                message = "语音识别被中断";
                break;
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                code = "TOO_MANY";
                message = "系统语音服务请求过于频繁，请稍后重试";
                break;
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                code = "LANG_NOT_SUPPORTED";
                message = "系统语音服务不支持中文识别";
                break;
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                code = "LANG_UNAVAILABLE";
                message = "系统语音服务缺少中文语言包";
                break;
            default:
                code = "UNKNOWN";
                message = "系统语音识别失败（code=" + error + "）";
                break;
        }

        destroyRecognizer();
        rejectPending(message, code);

        // 让前端知道这次失败，可用于自动切回云端识别
        JSObject data = new JSObject();
        data.put("code", error);
        data.put("reason", code);
        data.put("message", message);
        data.put("service", currentService);
        notifyListeners("error", data);
    }

    @Override
    public void onResults(Bundle results) {
        String text = firstResult(results);
        JSObject data = new JSObject();
        data.put("text", text);
        data.put("service", currentService);
        notifyListeners("result", data);
        resolvePending(data);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        String text = firstResult(partialResults);
        if (text.isEmpty()) return;
        JSObject data = new JSObject();
        data.put("text", text);
        notifyListeners("partial", data);
    }

    @Override
    public void onEvent(int eventType, Bundle params) {
    }

    @Override
    protected void handleOnDestroy() {
        destroyRecognizer();
        pendingCall = null;
        super.handleOnDestroy();
    }
}
