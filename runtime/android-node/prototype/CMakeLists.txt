cmake_minimum_required(VERSION 3.22)
project(lishi_node_embed LANGUAGES CXX)

if(NOT ANDROID OR NOT ANDROID_ABI STREQUAL "arm64-v8a")
  message(FATAL_ERROR "This gate requires Android arm64-v8a")
endif()
if(ANDROID_PLATFORM_LEVEL LESS 24)
  message(FATAL_ERROR "Node embedder requires API 24 or later")
endif()
set(NODE_SOURCE_DIR "" CACHE PATH "Verified Node 24.19.0 source tree")
set(NODE_LIBRARY "" CACHE FILEPATH "Verified Android libnode.so")
if(NOT EXISTS "${NODE_SOURCE_DIR}/src/node_version.h" OR NOT EXISTS "${NODE_LIBRARY}")
  message(FATAL_ERROR "Provide the verified Node source and Android shared library")
endif()

add_library(node_runtime SHARED IMPORTED)
set_target_properties(node_runtime PROPERTIES IMPORTED_LOCATION "${NODE_LIBRARY}")
add_library(lishi_node_embed SHARED node_embed.cpp)
target_compile_features(lishi_node_embed PRIVATE cxx_std_20)
# Keep developer checkout paths out of built-in file and lambda diagnostics.
get_filename_component(LISHI_SOURCE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)
target_compile_options(lishi_node_embed PRIVATE
  "-ffile-prefix-map=${LISHI_SOURCE_ROOT}=/build/app"
  "-ffile-prefix-map=${NODE_SOURCE_DIR}=/build/node")
target_include_directories(lishi_node_embed PRIVATE
  "${NODE_SOURCE_DIR}/src"
  "${NODE_SOURCE_DIR}/deps/v8/include"
  "${NODE_SOURCE_DIR}/deps/uv/include")
target_link_libraries(lishi_node_embed PRIVATE node_runtime log)
target_link_options(lishi_node_embed PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
