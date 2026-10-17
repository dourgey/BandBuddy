#include "node.h"
#include "effects.h"
#include "wave-file.h"
#include "worker-wait.h"
#include <fstream>
#include <iostream>
#include <mutex>
#include <thread>
#include <deque>

using namespace bb;
using namespace bb::plugins;
namespace {
std::filesystem::path pathOf(const std::string& text) { return std::filesystem::u8path(text); }
void emit(const json& value) { std::cout << value.dump(-1, ' ', false, json::error_handler_t::replace) << '\n' << std::flush; }
struct Stage {
  std::string id;
  std::unique_ptr<Node> plugin;
  std::unique_ptr<Effects> builtin;
  bool bypass = false;
  unsigned latency = 0, cursor = 0;
  std::vector<float> delay;
};
struct Chain {
  std::vector<Stage> stages;
  float inputGain = 1, outputGain = 1;
  std::array<float, ipc::quantum * 2> temporary{};
  Chain(const json& description, double rate, bool offline = false) {
    inputGain = std::pow(10.f, description.value("inputGainDb", 0.f) / 20);
    outputGain = std::pow(10.f, description.value("outputGainDb", 0.f) / 20);
    for (const auto& item : description.at("nodes")) {
      Stage stage; stage.id = item.at("id"); stage.bypass = item.value("bypass", false);
      if (item.at("kind") == "builtin") stage.builtin = std::make_unique<Effects>(item.at("prepared"), unsigned(rate));
      else if (item.value("format", "vst3") == "vst3") stage.plugin = makeVst3(item, rate, offline);
#ifdef __APPLE__
      else if (item.value("format", "") == "auv2") stage.plugin = makeAu(item, rate, offline);
#endif
      else throw std::runtime_error("PLUGIN_FORMAT_UNAVAILABLE");
      stage.latency = stage.plugin ? stage.plugin->latency() : stage.builtin->latency();
      if (stage.latency > rate * 30) throw std::runtime_error("PLUGIN_LATENCY_RESOURCE_LIMIT");
      if (stage.bypass) stage.delay.resize(std::size_t(stage.latency) * 2, 0.f);
      stages.push_back(std::move(stage));
    }
  }
  void process(ipc::Block& block) {
    for (auto& value : block.samples) value *= inputGain;
    for (auto& stage : stages) {
      if (stage.bypass) {
        if (stage.latency) for (unsigned f = 0; f < block.frames; ++f) {
          for (unsigned c = 0; c < 2; ++c) std::swap(stage.delay[stage.cursor * 2 + c], block.samples[f * 2 + c]);
          stage.cursor = (stage.cursor + 1) % stage.latency;
        }
        continue;
      }
      if (stage.plugin) stage.plugin->process(block);
      else { stage.builtin->process(block.samples.data(), temporary.data(), block.frames, 2); block.samples = temporary; }
      // Keep the published clock stable. A plugin that changes its delay needs
      // a stopped/rebuilt chain; it cannot move the wet timeline mid-capture.
      if (stage.plugin && stage.plugin->latency() != stage.latency) throw std::runtime_error("PLUGIN_LATENCY_CHANGED_RESTART_REQUIRED:" + stage.id);
      for (const auto v : block.samples) if (!std::isfinite(v) || std::abs(v) > 64) throw std::runtime_error("PLUGIN_INVALID_AUDIO:" + stage.id);
    }
    for (auto& value : block.samples) value *= outputGain;
  }
  unsigned latency() const { unsigned value = 0; for (const auto& stage : stages) value += stage.latency; return value; }
  double tail() const { double result = 0; for (const auto& stage : stages) if (!stage.bypass && stage.plugin) { const auto seconds = stage.plugin->tailSeconds(); if (seconds < 0) return -1; result += seconds; } return result; }
  Node& node(const std::string& id) { for (auto& stage : stages) if (stage.id == id && stage.plugin) return *stage.plugin; throw std::runtime_error("PLUGIN_INSTANCE_MISSING"); }
  json info() { json result = json::array(); for (auto& stage : stages) if (stage.plugin) { auto item = stage.plugin->info(); item["instanceId"] = stage.id; result.push_back(item); } return result; }
};
int render(const std::string& manifest) {
  std::ifstream file(pathOf(manifest)); const auto config = json::parse(file);
  WaveReader input(pathOf(config.at("input")));
  Chain chain(config.at("graph"), input.rate(), true);
  const double limit = std::clamp(config.value("tailLimitSeconds", 30.), 0., 120.);
  const double reportedTail = chain.tail();
  const double seconds = reportedTail < 0 ? limit : std::min(limit, std::max(reportedTail, config.value("tailSeconds", 0.)));
  const auto tail = std::uint64_t(std::ceil(seconds * input.rate()));
  const auto latency = chain.latency();
  const auto total = input.frames() + tail;
  const double tempo = config.value("tempo", 120.);
  const double offsetSeconds = config.value("positionMs", 0.) / 1000;
  const double beatOffsetSeconds = config.value("beatOffsetMs", 0.) / 1000;
  if (!std::isfinite(tempo) || tempo < 10 || tempo > 800 || !std::isfinite(offsetSeconds) || offsetSeconds < 0 || !std::isfinite(beatOffsetSeconds)) throw std::runtime_error("PLUGIN_RENDER_CLOCK_INVALID");
  std::ofstream output(pathOf(config.at("output")), std::ios::binary | std::ios::trunc);
  writeWaveHeader(output, input.rate(), 2, total * 8);
  std::array<float, ipc::quantum * 2> source{};
  for (std::uint64_t position = 0; position < total + latency; position += ipc::quantum) {
    ipc::Block block; block.frames = unsigned(std::min<std::uint64_t>(ipc::quantum, total + latency - position));
    input.read(position, source.data(), block.frames); block.sampleRate = input.rate();
    block.samplePosition = position + std::uint64_t(offsetSeconds * input.rate()); block.continuousPosition = position;
    block.tempo = tempo; block.projectTimeMusic = (position / double(input.rate()) + offsetSeconds - beatOffsetSeconds) * tempo / 60;
    block.playing = 1;
    for (unsigned f = 0; f < block.frames; ++f) for (unsigned c = 0; c < 2; ++c) block.samples[f * 2 + c] = source[f * input.channels() + std::min(c, input.channels() - 1)];
    chain.process(block);
    if (chain.latency() != latency) throw std::runtime_error("PLUGIN_OFFLINE_LATENCY_CHANGED");
    const auto skip = unsigned(std::min<std::uint64_t>(block.frames, position < latency ? latency - position : 0));
    output.write(reinterpret_cast<const char*>(block.samples.data() + skip * 2), (block.frames - skip) * 8);
    if (!output) throw std::runtime_error("PLUGIN_RENDER_WRITE_FAILED");
    pumpPlatform();
  }
  output.flush(); if (!output) throw std::runtime_error("PLUGIN_RENDER_WRITE_FAILED");
  emit({{"frames", total}, {"latencyFrames", latency}, {"tailSeconds", seconds}, {"tailCapped", reportedTail < 0 || reportedTail > limit}}); return 0;
}
int worker(const std::string& manifest) {
  std::ifstream file(pathOf(manifest)); const auto config = json::parse(file);
  const double rate = config.value("sampleRate", 48000.);
  if (!std::isfinite(rate) || rate < 8000 || rate > 192000) throw std::runtime_error("PLUGIN_RATE_INVALID");
  ipc::Mapping mapping(pathOf(config.at("mapping")), true, config.at("generation"));
  Chain chain(config.at("graph"), rate);
  auto& shared = mapping.data(); shared.latency.store(chain.latency()); shared.ready.store(1, std::memory_order_release);
  std::mutex processingMutex, controlMutex;
  std::deque<json> commands; std::atomic<bool> eof{false}, stopped{false}; std::string failure;
  std::atomic<bool> realtimePriority{false};
  std::thread reader([&] {
    std::string line;
    // Control messages only. PCM never appears on stdin/stdout.
    while (std::getline(std::cin, line)) {
      if (line.size() > 1024 * 1024) break;
      try { auto command = json::parse(line); std::lock_guard lock(controlMutex); if (commands.size() >= 128) break; commands.push_back(std::move(command)); }
      catch (...) { break; }
    }
    eof.store(true);
  });
  std::thread processor([&] {
    AudioThreadPriority scheduling; realtimePriority.store(scheduling.active());
    WorkerWait idle;
    while (!stopped.load() && !shared.shutdown.load()) {
      const auto* next = shared.input.front();
      if (!next) { idle.wait(std::chrono::microseconds(250)); continue; }
      auto block = *next; shared.input.pop();
      if (block.generation != shared.generation || block.frames != ipc::quantum || block.channels != 2 || block.sampleRate != rate) continue;
      { std::lock_guard lock(processingMutex);
        if (shared.fault.load()) block.error = 1;
        else try { chain.process(block); shared.latency.store(chain.latency()); }
        catch (const std::exception& e) { failure = e.what(); shared.fault.store(1); block.error = 1; }
      }
      if (block.error) block.samples.fill(0);
      shared.output.push(block); shared.heartbeat.fetch_add(1);
    }
  });
  emit({{"event", "ready"}, {"data", {{"protocol", ipc::version}, {"latencyFrames", chain.latency() + ipc::quantum * ipc::depth}, {"instances", chain.info()}}}});
  while (!eof.load() && !stopped.load()) {
    pumpPlatform();
    json command;
    { std::lock_guard lock(controlMutex); if (!commands.empty()) { command = std::move(commands.front()); commands.pop_front(); } }
    if (command.is_null()) { std::this_thread::sleep_for(std::chrono::milliseconds(2)); continue; }
    const auto id = command.value("id", 0);
    try {
      const auto method = command.value("method", ""); const auto params = command.value("params", json::object()); json result = true;
      std::lock_guard lock(processingMutex);
      if (method == "shutdown") stopped.store(true);
      else if (method == "status") result = {{"fault", shared.fault.load()}, {"error", failure}, {"latencyFrames", chain.latency() + ipc::quantum * ipc::depth}, {"heartbeat", shared.heartbeat.load()}, {"realtimePriority", realtimePriority.load()}};
      else {
        auto& node = chain.node(params.at("instanceId"));
        if (method == "editor") node.editor(params.value("open", true));
        else if (method == "parameters") result = node.parameters();
        else if (method == "parameter") node.parameter(params.at("parameterId"), params.at("value"));
        else if (method == "save") node.save(params.at("path"));
        else throw std::runtime_error("PLUGIN_COMMAND_UNKNOWN");
      }
      emit({{"id", id}, {"ok", true}, {"result", result}});
    } catch (const std::exception& e) { emit({{"id", id}, {"ok", false}, {"error", e.what()}}); }
  }
  stopped.store(true); shared.ready.store(0); shared.shutdown.store(1);
  processor.join();
  // stdin can remain open after a graceful command. The supervisor closes it
  // before shutdown; EOF is the normal worker lifetime boundary.
  if (reader.joinable()) reader.join();
  return 0;
}
}
int runMain(int argc, char** argv) {
  try {
    initializePlatform();
#ifdef __APPLE__
    if (argc == 2 && std::string(argv[1]) == "--list-au") { emit(enumerateAu()); return 0; }
    if (argc == 3 && std::string(argv[1]) == "--scan-au") { emit(scanAu(argv[2])); return 0; }
#endif
    if (argc == 3 && std::string(argv[1]) == "--scan") { emit(scanVst3(argv[2])); return 0; }
    if (argc == 3 && std::string(argv[1]) == "--worker") return worker(argv[2]);
    if (argc == 3 && std::string(argv[1]) == "--render") return render(argv[2]);
    throw std::runtime_error("PLUGIN_HOST_ARGUMENTS_INVALID");
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> arguments;
  for (int i = 0; i < argc; ++i) {
    const auto utf8 = std::filesystem::path(argv[i]).u8string();
    arguments.emplace_back(utf8.begin(), utf8.end());
  }
  std::vector<char*> pointers;
  for (auto& argument : arguments) pointers.push_back(argument.data());
  return runMain(argc, pointers.data());
}
#else
int main(int argc, char** argv) { return runMain(argc, argv); }
#endif
