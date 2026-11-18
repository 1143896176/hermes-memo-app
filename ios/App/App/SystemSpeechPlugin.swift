import Foundation
import AVFoundation
import Speech
import Capacitor

/**
 * 系统语音识别插件（iOS SFSpeechRecognizer + AVAudioEngine）
 *
 * 为什么要有它：WKWebView 里没有 webkitSpeechRecognition（那是 Safari 的私有实现，
 * 只在页面跑在 Safari 里时才暴露），所以 iOS 上"实时出字、不烧 ASR 额度"只能靠
 * 系统识别框架。Android 侧对应实现是 android/app/src/main/java/com/hermes/memo/
 * SystemSpeechPlugin.java，两边对外暴露同一套 JS 契约，前端不用分叉。
 *
 * 与 Android 的三个本质差异（决定了代码结构不一样）：
 *  1. Android 是「一把梭」：startListening 之后由系统服务负责录音和出字。
 *     iOS 必须自己开 AVAudioEngine 采音、自己把 buffer 喂给
 *     SFSpeechAudioBufferRecognitionRequest，于是多了音频会话、tap、静音检测这些活。
 *  2. Android 能枚举多家识别服务（厂商 vs Google），iOS 只有系统一家，
 *     所以 probe() 固定返回一条记录，googleOnly 恒为 false。
 *  3. Android 没有识别服务就是"本机不支持"；iOS 还有「离线识别」可选
 *     （supportsOnDeviceRecognition）。默认优先离线，省流量也不受网络影响；
 *     离线模型没下好导致失败时，自动退回在线识别重试一次，用户不用重说。
 *
 * 权限：麦克风（NSMicrophoneUsageDescription）+ 语音识别
 * （NSSpeechRecognitionUsageDescription）。缺后者不是"功能不可用"，是进程直接崩，
 * 两个键由 scripts/ios-setup.mjs 统一维护。
 *
 * 前端用法（src/services/system-speech.ts）：
 *   probe()             → { available, services[], googleOnly, selected, selectedLabel, onDevice }
 *   available()         → { available: boolean }
 *   start({ language, preferOnDevice }) → { text }   // 说完（或调用 stop()）后 resolve
 *   stop() / cancel()
 *   事件：started / partial / result / error
 */
@objc(SystemSpeechPlugin)
public class SystemSpeechPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "SystemSpeechPlugin"
    public let jsName = "SystemSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    // iOS 只有系统一家识别服务，这两个值是给前端展示用的静态标识。
    // label 会拼进按钮文案「系统语音识别（iOS 系统）」，所以写短一点。
    private let serviceId = "com.apple.SpeechRecognition"
    private let serviceLabel = "iOS 系统"

    // 单次识别时长上限：SFSpeechRecognizer 单个请求约 1 分钟就会断开，
    // 留 5s 余量主动收尾，比被系统掐断的体验好
    private let maxDuration: TimeInterval = 55
    // 一直没检测到人声就放弃，避免用户对着"正在听"干等
    private let noSpeechTimeout: TimeInterval = 8
    // 说完停顿多久算一句结束（比 Android 的 1.2s 稍长，中文短句停顿多）
    private let silenceFinish: TimeInterval = 1.5
    // 停止采音后等 final result 的兜底时长，拿不到就用手里的 partial 收尾
    private let finalFallbackDelay: TimeInterval = 2.0

    private var recognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine: AVAudioEngine?
    private var tapInstalled = false

    private var pendingCall: CAPPluginCall?
    private var currentLanguage = "zh-CN"
    private var latestText = ""
    private var isFinishing = false
    private var isRunning = false
    private var preferOnDevice = true
    private var retriedOnline = false

    /// 会话代号：每次 begin/重试都 +1。旧任务迟到的回调凭代号丢弃，
    /// 否则"重试"时被 cancel 的旧任务会回一个错误，把新会话直接判死。
    private var sessionToken = 0

    private var startedAt = Date()
    private var silenceTimer: Timer?
    private var maxTimer: Timer?
    private var finalTimer: Timer?
    private var observers: [NSObjectProtocol] = []

    // 采音线程写、主线程读，用锁保护
    private let levelLock = NSLock()
    private var hasSpeech = false
    private var lastVoiceAt = Date()

    // ── 插件入口 ──

    @objc public func probe(_ call: CAPPluginCall) {
        let rec = SFSpeechRecognizer(locale: Locale(identifier: currentLanguage))
        let status = SFSpeechRecognizer.authorizationStatus()

        // denied / restricted 时前端应直接走云端，不要白点一次
        let usable = rec != nil && status != .denied && status != .restricted

        let service: [String: Any] = [
            "packageName": serviceId,
            "className": "SFSpeechRecognizer",
            "label": serviceLabel,
            "google": false,
            "system": true
        ]

        var result: [String: Any] = [
            "available": usable,
            "services": [service],
            // iOS 没有 Google 系服务这回事，但字段保留：前端两端共用一套判断
            "googleOnly": false,
            // 离线识别是否可用（iOS 13+ 且该语言模型已下载）
            "onDevice": rec?.supportsOnDeviceRecognition ?? false,
            "authStatus": Self.authStatusName(status),
            "micGranted": Self.micGranted()
        ]
        // selected / selectedLabel 用 if-else 而不是三目：Swift 里
        // String 和 NSNull 混在一个表达式里推断不出类型
        if usable {
            result["selected"] = serviceId
            result["selectedLabel"] = serviceLabel
        } else {
            result["selected"] = NSNull()
            result["selectedLabel"] = NSNull()
        }

        call.resolve(result)
    }

    @objc public func available(_ call: CAPPluginCall) {
        let rec = SFSpeechRecognizer(locale: Locale(identifier: currentLanguage))
        let status = SFSpeechRecognizer.authorizationStatus()
        call.resolve([
            "available": rec != nil && status != .denied && status != .restricted
        ])
    }

    @objc public func start(_ call: CAPPluginCall) {
        // 同一时间只允许一个识别会话，和 Android 插件的 BUSY 语义保持一致
        if pendingCall != nil || isRunning {
            call.reject("上一次识别还没结束", "BUSY")
            return
        }

        currentLanguage = call.getString("language") ?? "zh-CN"
        preferOnDevice = call.getBool("preferOnDevice") ?? true
        latestText = ""
        isFinishing = false
        retriedOnline = false
        hasSpeech = false
        lastVoiceAt = Date()
        pendingCall = call

        // 两重授权：先语音识别、再麦克风。任何一步被拒都要给能操作的提示，
        // 而不是笼统的"识别失败"——iOS 一旦拒绝，只能去设置里手动开回来。
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self = self else { return }
            // 授权回调在任意队列，插件状态改动和 JS 回调统一回主线程
            self.onMain {
                guard status == .authorized else {
                    let message: String
                    switch status {
                    case .denied:
                        message = "语音识别权限被拒绝，请到「设置 → 隐私与安全性 → 语音识别」里允许本 App"
                    case .restricted:
                        message = "本机限制了语音识别（家长控制或设备管理策略）"
                    case .notDetermined:
                        message = "语音识别权限尚未授权，请重试并在弹窗里点「允许」"
                    default:
                        message = "语音识别不可用"
                    }
                    self.fail(message, code: "PERMISSION_DENIED")
                    return
                }
                Self.requestMicPermission { granted in
                    guard self.pendingCall != nil else { return }   // 期间被 cancel 了
                    guard granted else {
                        self.fail("麦克风权限被拒绝，请到「设置 → 隐私与安全性 → 麦克风」里允许本 App", code: "PERMISSION_DENIED")
                        return
                    }
                    self.begin()
                }
            }
        }
    }

    @objc public func stop(_ call: CAPPluginCall) {
        // 已说的话仍要出结果：只结束采音，等 final result 回来再 resolve
        if isRunning && !isFinishing {
            endAudioAndWait()
        }
        call.resolve()
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        cleanup()
        rejectPending("已取消", code: "CANCELLED")
        call.resolve()
    }

    // ── 会话启动 ──

    private func begin() {
        guard pendingCall != nil else { return }

        let locale = Locale(identifier: currentLanguage)
        guard let rec = SFSpeechRecognizer(locale: locale) else {
            fail("系统语音识别不支持当前语言（\(currentLanguage)）", code: "LANG_NOT_SUPPORTED")
            return
        }
        // 注意：这里不查 rec.isAvailable。它反映的是"在线服务是否可达"，
        // 飞行模式下用离线识别照样能跑，提前拒绝反而误伤；真出问题由
        // recognitionTask 的回调给出具体错误，前端再决定是否转云端。
        recognizer = rec

        sessionToken += 1
        let token = sessionToken

        do {
            try configureAudioSession()
        } catch {
            fail("无法打开麦克风：\(error.localizedDescription)", code: "AUDIO")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // dictation：适合"说一整句话"，比 search 模式更愿意保留长句
        request.taskHint = .dictation

        // 离线优先：不依赖网络、不上传音频。模型没下载时会失败，
        // 由 retryOnlineIfNeeded 自动退回在线识别。
        if rec.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = preferOnDevice
        }
        recognitionRequest = request

        guard startEngine(feeding: request) else {
            fail("麦克风初始化失败，请重试", code: "AUDIO")
            return
        }

        recognitionTask = rec.recognitionTask(with: request) { [weak self] result, error in
            self?.handleResult(result, error: error, token: token)
        }

        isRunning = true
        startedAt = Date()
        lastVoiceAt = Date()
        observeInterruptions()
        startTimers()
        notifyListeners("started", data: [:])
    }

    /// 建引擎 + 装 tap + 起播。重试在线识别时也要用同一套，所以抽出来。
    private func startEngine(feeding request: SFSpeechAudioBufferRecognitionRequest) -> Bool {
        stopEngine()

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return false }

        // 每帧算一次能量：既用于静音收尾，也能在"完全没人说话"时早点放弃
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            request.append(buffer)
            self.trackLevel(buffer)
        }
        tapInstalled = true

        engine.prepare()
        do {
            try engine.start()
        } catch {
            return false
        }

        audioEngine = engine
        return true
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        // .measurement 关掉系统降噪/AGC，识别引擎拿到的最接近原始人声；
        // .record 只采不放，不会和页面里的音频播放打架。
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true)
    }

    private func deactivateAudioSession() {
        do {
            // notifyOthersOnDeactivation：把麦克风还回去，也保证紧接着走
            // "云端录音"时 getUserMedia 能立刻拿到设备
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // 失败就交给下一次 setActive 自愈，不值得打断用户
        }
    }

    // ── 结果与收尾 ──

    private func handleResult(_ result: SFSpeechRecognitionResult?, error: Error?, token: Int) {
        // 回调在任意队列，统一搬到主线程改状态，避免和 stop() 抢同一批变量
        onMain { [weak self] in
            guard let self = self, token == self.sessionToken, self.pendingCall != nil else { return }

            if let result = result {
                let text = result.bestTranscription.formattedString
                if !text.isEmpty {
                    self.latestText = text
                    self.markSpeech()
                    self.notifyListeners("partial", data: ["text": text])
                }
                if result.isFinal {
                    self.finish(with: text)
                    return
                }
            }

            guard let error = error else { return }

            // 收尾阶段系统常回一个"被取消"，这是预期内的，不用报给用户
            if self.isFinishing { return }

            // 离线模型缺失/不可用 → 退回在线识别重试一次（用户不用重说）
            if self.retryOnlineIfNeeded() { return }

            let mapped = Self.mapError(error)
            let ns = error as NSError
            self.fail(mapped.message, code: mapped.code, extra: ["nativeCode": ns.code, "domain": ns.domain])
        }
    }

    /// 离线识别失败且还没出过字时，切在线再来一次。返回 true 表示已重启。
    private func retryOnlineIfNeeded() -> Bool {
        guard !retriedOnline,
              let rec = recognizer,
              rec.supportsOnDeviceRecognition,
              recognitionRequest?.requiresOnDeviceRecognition == true,
              latestText.isEmpty else { return false }

        retriedOnline = true
        preferOnDevice = false

        // 先换代号再 cancel：cancel() 会同步回一个"已取消"错误，
        // 代号没变的话这个回调会重入 handleResult，把这次重试自己判死
        sessionToken += 1
        let token = sessionToken
        recognitionTask?.cancel()
        recognitionTask = nil

        do {
            try configureAudioSession()
        } catch {
            return false
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = false
        recognitionRequest = request

        guard startEngine(feeding: request) else { return false }

        recognitionTask = rec.recognitionTask(with: request) { [weak self] result, error in
            self?.handleResult(result, error: error, token: token)
        }
        lastVoiceAt = Date()
        return true
    }

    /// 已停止采音，等 final result；等不到就用手里的 partial 兜底
    private func endAudioAndWait() {
        isFinishing = true
        stopTimers()
        stopEngine()
        // 只 endAudio 不 cancel：cancel 会丢掉已经识别出来的文本
        recognitionRequest?.endAudio()

        if finalTimer == nil {
            finalTimer = Timer.scheduledTimer(withTimeInterval: finalFallbackDelay, repeats: false) { [weak self] _ in
                guard let self = self else { return }
                self.finish(with: self.latestText)
            }
        }
    }

    private func finish(with text: String) {
        guard pendingCall != nil else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // 空文本也 resolve（前端统一提示"没有听清"），只有真错误才 reject
        cleanup()
        let data: [String: Any] = ["text": trimmed, "service": serviceLabel]
        notifyListeners("result", data: data)
        resolvePending(data)
    }

    private func fail(_ message: String, code: String, extra: [String: Any] = [:]) {
        guard pendingCall != nil else { return }
        cleanup()
        rejectPending(message, code: code)

        // 和 Android 一致：既 reject promise 也派发 error 事件，
        // 前端的云端降级逻辑只看 code/reason
        var data: [String: Any] = [
            "code": code,
            "reason": code,
            "message": message,
            "service": serviceLabel
        ]
        data.merge(extra) { _, new in new }
        notifyListeners("error", data: data)
    }

    /// 只停采音，保留任务以便拿到 final result
    private func stopEngine() {
        if let engine = audioEngine {
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            engine.stop()
        }
        audioEngine = nil
        isRunning = false
    }

    private func cleanup() {
        stopTimers()
        // 先让旧任务作废：cancel() 常会同步回调一个错误，代号一变它就进不来，
        // 否则会把刚结束的会话又当成"失败"再报一次
        sessionToken += 1
        stopEngine()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        removeObserving()
        recognizer = nil
        isFinishing = false
        retriedOnline = false
        if let timer = finalTimer {
            timer.invalidate()
            finalTimer = nil
        }
        deactivateAudioSession()
    }

    private func resolvePending(_ data: [String: Any]) {
        let call = pendingCall
        pendingCall = nil
        call?.resolve(data)
    }

    private func rejectPending(_ message: String, code: String) {
        let call = pendingCall
        pendingCall = nil
        call?.reject(message, code)
    }

    // ── 计时器：静音收尾 / 无语音放弃 / 时长上限 ──

    private func startTimers() {
        stopTimers()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.tick()
        }
        maxTimer = Timer.scheduledTimer(withTimeInterval: maxDuration, repeats: false) { [weak self] _ in
            self?.endAudioAndWait()
        }
    }

    private func stopTimers() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        maxTimer?.invalidate()
        maxTimer = nil
    }

    private func tick() {
        guard isRunning, !isFinishing, pendingCall != nil else { return }

        levelLock.lock()
        let spoke = hasSpeech
        let last = lastVoiceAt
        levelLock.unlock()

        let now = Date()

        // 一直没人说话 → 早点放弃，别让用户干等
        if !spoke {
            if now.timeIntervalSince(startedAt) > noSpeechTimeout {
                fail("没有检测到语音，请靠近麦克风再说一次", code: "SPEECH_TIMEOUT")
            }
            return
        }

        // 说过话后停顿超过阈值 → 认为这句说完了（与 Android 的自动收尾对齐）
        if now.timeIntervalSince(last) > silenceFinish {
            if latestText.isEmpty {
                fail("没有听清，请再说一次", code: "NO_MATCH")
            } else {
                endAudioAndWait()
            }
        }
    }

    // ── 采音电平 ──

    private func trackLevel(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return }

        var sum: Float = 0
        for i in 0..<frames {
            let v = channel[i]
            sum += v * v
        }
        let rms = sqrt(sum / Float(frames))

        // .measurement 下环境底噪大约 0.002~0.008，0.015 能区分正常说话
        if rms > 0.015 {
            markSpeech()
        }
    }

    private func markSpeech() {
        levelLock.lock()
        hasSpeech = true
        lastVoiceAt = Date()
        levelLock.unlock()
    }

    // ── 中断处理 ──

    private func observeInterruptions() {
        removeObserving()
        let center = NotificationCenter.default

        let interruption = center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.isRunning, !self.isFinishing else { return }
            self.fail("语音识别被打断（来电或其他 App 占用了麦克风）", code: "AUDIO")
        }

        let route = center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self, self.isRunning, !self.isFinishing else { return }
            // 拔耳机/切外放会让原来的 tap 失效，只能结束本次识别
            if let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
               raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                self.fail("录音设备被拔出，请重试", code: "AUDIO")
            }
        }

        observers = [interruption, route]
    }

    private func removeObserving() {
        let center = NotificationCenter.default
        for token in observers {
            center.removeObserver(token)
        }
        observers.removeAll()
    }

    // ── 工具 ──

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }

    private static func micGranted() -> Bool {
        if #available(iOS 17.0, *) {
            return AVAudioApplication.shared.recordPermission == .granted
        }
        return AVAudioSession.sharedInstance().recordPermission == .granted
    }

    private static func requestMicPermission(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        }
    }

    private static func authStatusName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    /// 把系统错误翻译成前端认识的 code（与 Android 插件的 code 集合对齐）
    private static func mapError(_ error: Error) -> (code: String, message: String) {
        let ns = error as NSError

        if ns.domain == NSURLErrorDomain || ns.code == -1009 || ns.code == -1001 {
            return ("NETWORK", "系统语音识别连不上网络，请检查网络后重试")
        }

        if ns.domain == "kAFAssistantErrorDomain" {
            switch ns.code {
            case 1101, 1107, 1110, 203:
                return ("NO_MATCH", "没有听清，请再说一次")
            case 216:
                return ("CANCELLED", "语音识别已取消")
            default:
                break
            }
        }

        // 会话中途被系统收回权限
        if ns.domain == "kLSRErrorDomain" && ns.code == 201 {
            return ("PERMISSION_DENIED", "语音识别权限不可用，请到系统设置里检查")
        }

        return ("UNKNOWN", "系统语音识别失败（\(ns.code)）")
    }

    deinit {
        silenceTimer?.invalidate()
        maxTimer?.invalidate()
        finalTimer?.invalidate()
        removeObserving()
    }
}
