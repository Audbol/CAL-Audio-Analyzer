{
  "targets": [
    {
      "target_name": "cal_audio",
      "sources": ["src/cal_audio.cpp", "vendor/rtaudio/RtAudio.cpp"],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")",
        "vendor/rtaudio",
        "vendor/rtaudio/include"
      ],
      "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "NODE_ADDON_API_DISABLE_DEPRECATED"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_CPP_RTTI": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "vendor/rtaudio/include/asio.cpp",
              "vendor/rtaudio/include/asiodrivers.cpp",
              "vendor/rtaudio/include/asiolist.cpp",
              "vendor/rtaudio/include/iasiothiscallresolver.cpp"
            ],
            "defines": ["__WINDOWS_ASIO__", "NOMINMAX", "_CRT_SECURE_NO_WARNINGS"],
            "libraries": ["-lwinmm", "-lole32", "-luser32", "-ladvapi32"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "RuntimeTypeInfo": "true",
                "AdditionalOptions": ["/std:c++17", "/EHsc"]
              }
            }
          }
        ],
        [
          "OS!='win'",
          {
            "libraries": ["-lpthread"]
          }
        ]
      ]
    }
  ]
}
