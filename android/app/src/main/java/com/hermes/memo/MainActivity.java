package com.hermes.memo;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件必须在 super.onCreate 之前注册，否则 bridge 初始化时找不到
        registerPlugin(SystemSpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
