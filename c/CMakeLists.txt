# Amagos C 판. 빌드는 c/tools/build.py 가 플랫폼별로 이 파일을 부른다 (docs/C_REWRITE_PLAN.md).
#   amagos_sim   시뮬레이션 + 생성 데이터 (SDL 없음)
#   amagos_cli   화면 없는 실행기
#   amagos_tests 규칙 시험
#   amagos       SDL3 앱 (Android 는 SDLActivity 가 읽는 공유 라이브러리 main)
cmake_minimum_required(VERSION 3.24)
project(amagos C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
option(AMAGOS_APP "SDL3 앱을 빌드한다" ON)
option(AMAGOS_TOOLS "실행기·시험을 빌드한다" ON)
set(SDL_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/SDL3-3.4.16 CACHE PATH "SDL3 소스 (c/tools/build.py fetch)")
set(AMAGOS_WEB_PGO_PROFILE "" CACHE FILEPATH "LLVM execution profile for the web build")

# ---------- data/*.csv → gen/data_gen.[ch] ----------
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(DATA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../data)
set(GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/gen)
file(GLOB DATA_CSV CONFIGURE_DEPENDS ${DATA_DIR}/*.csv)
add_custom_command(
  OUTPUT ${GEN_DIR}/data_gen.c ${GEN_DIR}/data_gen.h
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_data.py ${DATA_DIR} ${GEN_DIR}
  DEPENDS ${DATA_CSV} ${CMAKE_CURRENT_SOURCE_DIR}/data/lang_en.csv ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_data.py
  COMMENT "data/*.csv → C")

# ---------- 시뮬레이션 ----------
add_library(amagos_sim STATIC
  core/rng.c
  data/data.c
  data/lang.c
  sim/world.c
  sim/slots.c
  sim/targets.c
  sim/actions.c
  sim/combat.c
  sim/entities.c
  sim/cards_impl.c
  sim/spatial.c
  sim/game.c sim/deck.c
  ${GEN_DIR}/data_gen.c)
target_include_directories(amagos_sim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${GEN_DIR})
if(NOT WIN32)
  target_link_libraries(amagos_sim PUBLIC m)
endif()
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(amagos_sim PRIVATE -Wall -Wextra)
endif()

if(AMAGOS_TOOLS AND NOT ANDROID AND NOT EMSCRIPTEN)
  add_executable(amagos_cli tools/cli.c)
  target_link_libraries(amagos_cli PRIVATE amagos_sim)
  add_executable(amagos_gimmick_bench tools/gimmick_bench.c)
  target_link_libraries(amagos_gimmick_bench PRIVATE amagos_sim)
  add_executable(amagos_tests tests/test_main.c)
  target_link_libraries(amagos_tests PRIVATE amagos_sim)
  enable_testing()
  add_test(NAME rules COMMAND amagos_tests)
endif()

# ---------- SDL3 앱 ----------
if(AMAGOS_APP)
  if(ANDROID)
    set(SDL_SHARED ON CACHE BOOL "" FORCE)   # SDLActivity 가 libSDL3.so 와 libmain.so 를 읽는다
    set(SDL_STATIC OFF CACHE BOOL "" FORCE)
  else()
    set(SDL_SHARED OFF CACHE BOOL "" FORCE)
    set(SDL_STATIC ON CACHE BOOL "" FORCE)
  endif()
  set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)
  set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
  add_subdirectory(${SDL_DIR} ${CMAKE_CURRENT_BINARY_DIR}/SDL3 EXCLUDE_FROM_ALL)

  set(APP_SOURCES platform/main_sdl.c render/gfx.c render/render.c render/ui.c)
  if(ANDROID)
    add_library(main SHARED ${APP_SOURCES})
    set(APP_TARGET main)
  else()
    add_executable(amagos WIN32 ${APP_SOURCES})
    set(APP_TARGET amagos)
  endif()
  target_link_libraries(${APP_TARGET} PRIVATE amagos_sim SDL3::SDL3)
  target_include_directories(${APP_TARGET} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party)   # stb_truetype.h

  # ---------- 에셋: assets/ → 빌드 폴더 assets/ (글꼴은 woff2 → ttf) ----------
  set(ASSET_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../assets)
  set(ASSET_OUT ${CMAKE_CURRENT_BINARY_DIR}/assets)
  set(ASSET_FILES ${ASSET_OUT}/sprites/tiny_dungeon.png ${ASSET_OUT}/sprites/icons.png ${ASSET_OUT}/fonts/Galmuri11.ttf ${ASSET_OUT}/fonts/Galmuri11-Bold.ttf)
  # 글꼴은 화면 문자열(CSV·C 소스)에 쓰는 글자만 남기므로 그 파일들이 바뀌면 글자 집합을 다시 검사한다
  file(GLOB_RECURSE ASSET_TEXT_SOURCES CONFIGURE_DEPENDS
    ${CMAKE_CURRENT_SOURCE_DIR}/sim/*.[ch] ${CMAKE_CURRENT_SOURCE_DIR}/render/*.[ch] ${CMAKE_CURRENT_SOURCE_DIR}/platform/*.[ch]
    ${CMAKE_CURRENT_SOURCE_DIR}/core/*.[ch] ${CMAKE_CURRENT_SOURCE_DIR}/data/*.[ch])
  add_custom_command(
    OUTPUT ${ASSET_FILES}
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_assets.py ${ASSET_SRC} ${ASSET_OUT}
    DEPENDS ${ASSET_SRC}/sprites/tiny_dungeon.png ${ASSET_SRC}/sprites/icons.png ${ASSET_SRC}/fonts/Galmuri11.woff2 ${ASSET_SRC}/fonts/Galmuri11-Bold.woff2
            ${CMAKE_CURRENT_SOURCE_DIR}/tools/gen_assets.py ${DATA_CSV} ${CMAKE_CURRENT_SOURCE_DIR}/data/lang_en.csv ${ASSET_TEXT_SOURCES}
    COMMENT "assets")
  add_custom_target(amagos_assets DEPENDS ${ASSET_FILES})
  add_dependencies(${APP_TARGET} amagos_assets)

  if(EMSCRIPTEN)
    # Keep simulation/render helpers visible across translation units, without
    # changing floating-point semantics; SIMD is available in modern web builds.
    target_compile_options(amagos_sim PRIVATE -flto -msimd128)
    target_compile_options(amagos PRIVATE -flto -msimd128)
    if(AMAGOS_WEB_PGO_PROFILE)
      if(NOT EXISTS "${AMAGOS_WEB_PGO_PROFILE}")
        message(FATAL_ERROR "Missing PGO profile: ${AMAGOS_WEB_PGO_PROFILE}")
      endif()
      foreach(target amagos_sim amagos)
        target_compile_options(${target} PRIVATE
          "-fprofile-use=${AMAGOS_WEB_PGO_PROFILE}"
          -mllvm -static-func-strip-dirname-prefix=9999
          -Wno-profile-instr-unprofiled)
        get_target_property(profile_sources ${target} SOURCES)
        set_property(SOURCE ${profile_sources} APPEND PROPERTY OBJECT_DEPENDS "${AMAGOS_WEB_PGO_PROFILE}")
      endforeach()
      target_link_options(amagos PRIVATE
        "-fprofile-use=${AMAGOS_WEB_PGO_PROFILE}"
        -mllvm -static-func-strip-dirname-prefix=9999
        -Wno-profile-instr-unprofiled)
      set_property(TARGET amagos APPEND PROPERTY LINK_DEPENDS "${AMAGOS_WEB_PGO_PROFILE}")
    endif()
    set_target_properties(amagos PROPERTIES SUFFIX ".html")
    set_property(TARGET amagos APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/platform/web/shell.html ${ASSET_FILES})
    target_link_options(amagos PRIVATE
      "-flto" "-msimd128"
      "--shell-file=${CMAKE_CURRENT_SOURCE_DIR}/platform/web/shell.html"
      "-sMAX_WEBGL_VERSION=2"
      "-sALLOW_MEMORY_GROWTH=1"
      "-sINITIAL_MEMORY=64MB"
      "--preload-file=${ASSET_OUT}@/assets")
  endif()
endif()
