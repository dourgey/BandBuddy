# VST SDK 3.8.0 is MIT; retain its notices in packaged resources. Do not switch
# back to pre-MIT SDKs or introduce JUCE without choosing its licensing path.
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_AUV2_BUILDS OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
FetchContent_Declare(vst3sdk
  GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk.git
  GIT_TAG 9fad9770f2ae8542ab1a548a68c1ad1ac690abe0
  GIT_SUBMODULES base cmake pluginterfaces public.sdk
  GIT_SUBMODULES_RECURSE OFF)
FetchContent_MakeAvailable(vst3sdk)
set(sdkroot ${vst3sdk_SOURCE_DIR})
set(plugin_sources main.cpp vst3-node.cpp
  ${sdkroot}/public.sdk/source/vst/hosting/module.cpp
  ${sdkroot}/public.sdk/source/vst/hosting/plugprovider.cpp)
if(WIN32)
  list(APPEND plugin_sources editor-win.cpp ${sdkroot}/public.sdk/source/vst/hosting/module_win32.cpp)
elseif(APPLE)
  enable_language(OBJCXX)
  list(APPEND plugin_sources editor-mac.mm au-node.mm ${sdkroot}/public.sdk/source/vst/hosting/module_mac.mm)
endif()
add_executable(bandbuddy-plugin-host ${plugin_sources})
target_include_directories(bandbuddy-plugin-host PRIVATE ${sdkroot} ../audio-ipc)
target_link_libraries(bandbuddy-plugin-host PRIVATE sdk_hosting bandbuddy_effects nlohmann_json::nlohmann_json)
target_compile_definitions(bandbuddy-plugin-host PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)
if(WIN32)
  target_link_libraries(bandbuddy-plugin-host PRIVATE ole32 user32 shell32 avrt)
elseif(APPLE)
  target_link_libraries(bandbuddy-plugin-host PRIVATE "-framework Cocoa" "-framework AudioToolbox" "-framework AudioUnit")
endif()
if(MSVC)
  target_compile_options(bandbuddy-plugin-host PRIVATE /W4 /utf-8 /EHsc)
  # SDK 3.8.0's platform module uses pre-C++20 filesystem::u8string semantics.
  set_source_files_properties(${sdkroot}/public.sdk/source/vst/hosting/module_win32.cpp PROPERTIES COMPILE_OPTIONS "/std:c++17")
elseif(APPLE)
  set_source_files_properties(${sdkroot}/public.sdk/source/vst/hosting/module_mac.mm PROPERTIES COMPILE_OPTIONS "-std=c++17;-fobjc-arc")
endif()
install(TARGETS bandbuddy-plugin-host RUNTIME DESTINATION . COMPONENT BandBuddyAudioHost)
install(FILES ${sdkroot}/LICENSE.txt DESTINATION licenses RENAME VST3-SDK-LICENSE.txt COMPONENT BandBuddyAudioHost)
# The SDK's small delay effect provides a real VST3 lifecycle/state fixture.
option(BANDBUDDY_PLUGIN_TEST_FIXTURE "Build SDK delay effect for host tests" OFF)
if(BANDBUDDY_PLUGIN_TEST_FIXTURE)
  set(SDK_ROOT ${sdkroot})
  set(public_sdk_SOURCE_DIR ${sdkroot}/public.sdk)
  set(delayroot ${sdkroot}/public.sdk/samples/vst/adelay/source)
  smtg_add_vst3plugin(bandbuddy-test-delay
    ${delayroot}/adelaycontroller.cpp ${delayroot}/adelayprocessor.cpp
    ${delayroot}/factory.cpp ${delayroot}/exampletest.cpp
    ${sdkroot}/public.sdk/source/vst/utility/test/ringbuffertest.cpp
    ${sdkroot}/public.sdk/source/vst/utility/test/versionparsertest.cpp)
  target_link_libraries(bandbuddy-test-delay PRIVATE sdk)
  smtg_target_configure_version_file(bandbuddy-test-delay)
  target_include_directories(bandbuddy-test-delay PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
endif()
