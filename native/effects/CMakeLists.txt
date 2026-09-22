include(FetchContent)
FetchContent_Declare(nam_core
  GIT_REPOSITORY https://github.com/sdatkinson/NeuralAmpModelerCore.git
  GIT_TAG 1f42f88535884450104b8711d7595019afa0495b
  GIT_SUBMODULES Dependencies/eigen Dependencies/AudioDSPTools
)
FetchContent_GetProperties(nam_core)
if(NOT nam_core_POPULATED)
  FetchContent_Populate(nam_core)
endif()
file(GLOB NAM_SRC "${nam_core_SOURCE_DIR}/NAM/*.cpp" "${nam_core_SOURCE_DIR}/NAM/*.c" "${nam_core_SOURCE_DIR}/NAM/*/*.cpp")
# NAM architecture parsers register through static initializers. A static
# archive drops unreferenced parser objects, breaking both native and WASM
# loading ("No config parser registered"). Link every object into consumers.
add_library(bandbuddy_effects OBJECT effects.cpp whitebox.cpp classic.cpp fuzz.cpp ${NAM_SRC})
target_include_directories(bandbuddy_effects PUBLIC . "${nam_core_SOURCE_DIR}" "${nam_core_SOURCE_DIR}/Dependencies" "${nam_core_SOURCE_DIR}/Dependencies/nlohmann" "${nam_core_SOURCE_DIR}/Dependencies/eigen" "${nam_core_SOURCE_DIR}/Dependencies/AudioDSPTools" "${nam_core_SOURCE_DIR}/Dependencies/AudioDSPTools/Dependencies")
target_compile_definitions(bandbuddy_effects PUBLIC NAM_ENABLE_A2_FAST NOMINMAX NAM_SAMPLE_FLOAT)
target_compile_features(bandbuddy_effects PUBLIC cxx_std_20)
if(EMSCRIPTEN)
  target_compile_options(bandbuddy_effects PRIVATE -O3 -msimd128 -fexceptions)
  add_executable(arsenal-dsp wasm.cpp)
  target_link_libraries(arsenal-dsp PRIVATE bandbuddy_effects)
  target_compile_options(arsenal-dsp PRIVATE -O3 -msimd128 -fexceptions)
  target_link_options(arsenal-dsp PRIVATE -O3 -msimd128 -fexceptions -sDISABLE_EXCEPTION_CATCHING=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 "-sEXPORTED_FUNCTIONS=['_bb_create','_bb_destroy','_bb_update','_bb_process','_bb_error','_malloc','_free']" "-sEXPORTED_RUNTIME_METHODS=['UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPF32','HEAPU8']")
endif()

if(NOT EMSCRIPTEN)
  add_executable(bandbuddy-effects-test whitebox_test.cpp)
  target_link_libraries(bandbuddy-effects-test PRIVATE bandbuddy_effects)
  add_executable(bandbuddy-classic-test classic_test.cpp)
  target_link_libraries(bandbuddy-classic-test PRIVATE bandbuddy_effects)
endif()
