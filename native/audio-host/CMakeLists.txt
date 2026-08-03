cmake_minimum_required(VERSION 3.24)
project(bandbuddy_audio_host VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(RTAUDIO_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(RTAUDIO_BUILD_PYTHON OFF CACHE BOOL "" FORCE)

if(WIN32)
  set(RTAUDIO_API_ASIO ON CACHE BOOL "" FORCE)
  # RtAudio 6.0.1 only implements WASAPI shared mode (its HOG_DEVICE path is
  # still a TODO), so WASAPI is supplied by the Windows-only PortAudio adapter.
  set(RTAUDIO_API_WASAPI OFF CACHE BOOL "" FORCE)
  set(RTAUDIO_API_DS OFF CACHE BOOL "" FORCE)
  set(PA_BUILD_STATIC ON CACHE BOOL "" FORCE)
  set(PA_BUILD_SHARED OFF CACHE BOOL "" FORCE)
  set(PA_DISABLE_INSTALL ON CACHE BOOL "" FORCE)
  set(PA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(PA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(PA_USE_ASIO OFF CACHE BOOL "" FORCE)
  set(PA_USE_DS OFF CACHE BOOL "" FORCE)
  set(PA_USE_WMME OFF CACHE BOOL "" FORCE)
  set(PA_USE_WDMKS OFF CACHE BOOL "" FORCE)
  set(PA_USE_WASAPI ON CACHE BOOL "" FORCE)
elseif(APPLE)
  set(RTAUDIO_API_CORE ON CACHE BOOL "" FORCE)
endif()

include(FetchContent)
set(BANDBUDDY_GITHUB_PROXY "" CACHE STRING "Optional URL prefix for GitHub downloads")
function(bandbuddy_github_urls output url)
  set(urls)
  if(BANDBUDDY_GITHUB_PROXY)
    string(REGEX REPLACE "/+$" "" proxy "${BANDBUDDY_GITHUB_PROXY}")
    list(APPEND urls "${proxy}/${url}")
  endif()
  list(APPEND urls "${url}")
  set(${output} ${urls} PARENT_SCOPE)
endfunction()
bandbuddy_github_urls(RTAUDIO_URLS "https://github.com/thestk/rtaudio/archive/refs/tags/6.0.1.tar.gz")
bandbuddy_github_urls(NLOHMANN_JSON_URLS "https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz")
bandbuddy_github_urls(PORTAUDIO_URLS "https://github.com/PortAudio/portaudio/archive/refs/tags/v19.7.0.tar.gz")
FetchContent_Declare(
  rtaudio
  URL ${RTAUDIO_URLS}
  URL_HASH SHA256=7206c8b6cee43b474f43d64988fefaadfdcfc4264ed38d8de5f5d0e6ddb0a123
)
FetchContent_Declare(
  nlohmann_json
  URL ${NLOHMANN_JSON_URLS}
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
)
if(WIN32)
  FetchContent_Declare(
    portaudio
    URL ${PORTAUDIO_URLS}
    URL_HASH SHA256=5af29ba58bbdbb7bbcefaaecc77ec8fc413f0db6f4c4e286c40c3e1b83174fa0
  )
  FetchContent_MakeAvailable(rtaudio nlohmann_json portaudio)
  target_compile_definitions(portaudio_static PRIVATE PA_WASAPI_MAX_CONST_DEVICE_COUNT=64)
else()
  FetchContent_MakeAvailable(rtaudio nlohmann_json)
endif()

add_executable(bandbuddy-audio-host src/main.cpp)
target_link_libraries(bandbuddy-audio-host PRIVATE rtaudio nlohmann_json::nlohmann_json)
target_compile_definitions(bandbuddy-audio-host PRIVATE NOMINMAX _CRT_SECURE_NO_WARNINGS)

if(WIN32)
  target_link_libraries(bandbuddy-audio-host PRIVATE portaudio_static)
  target_compile_definitions(bandbuddy-audio-host PRIVATE BANDBUDDY_PORTAUDIO_WASAPI PA_WASAPI_MAX_CONST_DEVICE_COUNT=64)
endif()

if(MSVC)
  target_compile_options(bandbuddy-audio-host PRIVATE /W4 /permissive- /EHsc)
else()
  target_compile_options(bandbuddy-audio-host PRIVATE -Wall -Wextra -Wpedantic)
endif()

install(
  TARGETS bandbuddy-audio-host
  RUNTIME DESTINATION .
  COMPONENT BandBuddyAudioHost
)
