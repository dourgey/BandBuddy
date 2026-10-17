#pragma once
#include "shared-audio.h"
#include <nlohmann/json.hpp>
#include <memory>
#include <string>

namespace bb::plugins {
using json = nlohmann::json;
struct Node {
  virtual ~Node() = default;
  virtual void process(ipc::Block& block) = 0;
  virtual json info() = 0;
  virtual json parameters() = 0;
  virtual void parameter(unsigned id, double value) = 0;
  virtual void save(const std::string& path) = 0;
  virtual void editor(bool open) = 0;
  virtual unsigned latency() const = 0;
  virtual double tailSeconds() const = 0;
};
std::unique_ptr<Node> makeVst3(const json& config, double rate, bool offline = false);
json scanVst3(const std::string& path);
#ifdef __APPLE__
std::unique_ptr<Node> makeAu(const json& config, double rate, bool offline);
json enumerateAu();
json scanAu(const std::string& id);
#endif
void initializePlatform();
void pumpPlatform();
void* openEditorWindow(void* view, const std::string& title);
void resizeEditorWindow(void* window, int width, int height);
void closeEditorWindow(void* window);
void showEditorWindow(void* window);
}
