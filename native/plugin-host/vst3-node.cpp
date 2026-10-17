#include "node.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/utility/memoryibstream.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include <fstream>
#include <mutex>
#include <iostream>

namespace bb::plugins {
using namespace Steinberg;
using namespace Steinberg::Vst;
namespace hosting = VST3::Hosting;
static HostApplication host;
static std::filesystem::path filePath(const std::string& value) { return std::filesystem::u8path(value); }
static void check(tresult result, const char* operation) {
  if (result != kResultOk) throw std::runtime_error(operation);
}
static std::string text16(const char16* input) {
  std::string result;
  for (const auto* p = input; *p; ++p) {
    const auto c = unsigned(*p);
    if (c < 128) result += char(c);
    else if (c < 2048) { result += char(192 | (c >> 6)); result += char(128 | (c & 63)); }
    else { result += char(224 | (c >> 12)); result += char(128 | ((c >> 6) & 63)); result += char(128 | (c & 63)); }
  }
  return result;
}
class VstNode final : public Node, public U::Implements<U::Directly<IComponentHandler, IPlugFrame>> {
 public:
  VstNode(const json& config, double rate, bool offline) : rate_(rate), offline_(offline) {
    std::string error;
    module_ = hosting::Module::create(config.at("path"), error);
    if (!module_) throw std::runtime_error("PLUGIN_LOAD_FAILED:" + error);
    module_->getFactory().setHostContext(&host);
    PluginContextFactory::instance().setPluginContext(&host);
    PlugProvider::setErrorStream(&std::cerr);
    bool found = false;
    for (const auto& info : module_->getFactory().classInfos()) if (info.ID().toString() == config.at("pluginId").get<std::string>()) {
      if (info.category() != kVstAudioEffectClass || info.subCategoriesString().find("Instrument") != std::string::npos)
        throw std::runtime_error("PLUGIN_INSTRUMENT_REQUIRES_MIDI_TRACK");
      definition_ = {{"format", "vst3"}, {"pluginId", info.ID().toString()}, {"name", info.name()},
        {"manufacturer", info.vendor()}, {"version", info.version()}, {"category", info.subCategoriesString()}};
      provider_ = std::make_unique<PlugProvider>(module_->getFactory(), info, true);
      if (!provider_->initialize()) throw std::runtime_error("PLUGIN_INITIALIZE_FAILED");
      found = true; break;
    }
    if (!found) throw std::runtime_error("PLUGIN_ID_MISSING");
    component_ = provider_->getComponentPtr(); controller_ = provider_->getControllerPtr();
    processor_ = FUnknownPtr<IAudioProcessor>(component_);
    if (!processor_) throw std::runtime_error("PLUGIN_PROCESSOR_MISSING");
    if (controller_) controller_->setComponentHandler(this);
    if (config.contains("statePath") && !config["statePath"].is_null()) restore(config["statePath"]);
    if (component_->getBusCount(kAudio, kInput) < 1 || component_->getBusCount(kAudio, kOutput) < 1)
      throw std::runtime_error("PLUGIN_AUDIO_BUSES_UNSUPPORTED");
    check(processor_->canProcessSampleSize(kSample32), "PLUGIN_FLOAT32_UNSUPPORTED");
    // Prefer stereo. Fallbacks explicitly downmix stereo to mono by averaging;
    // mono output is duplicated at the next stereo boundary.
    bool arranged = false;
    for (const auto layout : {std::pair{SpeakerArr::kStereo, SpeakerArr::kStereo},
         std::pair{SpeakerArr::kMono, SpeakerArr::kStereo}, std::pair{SpeakerArr::kMono, SpeakerArr::kMono},
         std::pair{SpeakerArr::kStereo, SpeakerArr::kMono}}) {
      auto in = layout.first, out = layout.second;
      if (processor_->setBusArrangements(&in, 1, &out, 1) == kResultOk) { arranged = true; break; }
    }
    if (!arranged) throw std::runtime_error("PLUGIN_BUS_LAYOUT_UNSUPPORTED");
    for (const auto direction : {kInput, kOutput}) for (int bus = 0; bus < component_->getBusCount(kAudio, direction); ++bus)
      check(component_->activateBus(kAudio, direction, bus, bus == 0), "PLUGIN_ACTIVATE_BUS_FAILED");
    for (const auto direction : {kInput, kOutput}) for (int bus = 0; bus < component_->getBusCount(kEvent, direction); ++bus)
      component_->activateBus(kEvent, direction, bus, false);
    ProcessSetup setup{offline ? kOffline : kRealtime, kSample32, ipc::quantum, rate};
    check(processor_->setupProcessing(setup), "PLUGIN_PREPARE_FAILED");
    if (!data_.prepare(*component_, ipc::quantum, kSample32)) throw std::runtime_error("PLUGIN_BUFFER_PREPARE_FAILED");
    if (data_.inputs[0].numChannels < 1 || data_.inputs[0].numChannels > 2 || data_.outputs[0].numChannels < 1 || data_.outputs[0].numChannels > 2)
      throw std::runtime_error("PLUGIN_BUS_LAYOUT_UNSUPPORTED");
    data_.processMode = setup.processMode;
    data_.inputParameterChanges = &changes_;
    data_.outputParameterChanges = &outputChanges_;
    data_.processContext = &context_;
    check(component_->setActive(true), "PLUGIN_ACTIVATE_FAILED"); active_ = true;
    check(processor_->setProcessing(true), "PLUGIN_START_FAILED"); processing_ = true;
    updateLatency();
  }
  ~VstNode() override {
    editor(false);
    if (processing_) processor_->setProcessing(false);
    if (active_) component_->setActive(false);
    if (controller_) controller_->setComponentHandler(nullptr);
    processor_ = nullptr; controller_ = nullptr; component_ = nullptr;
    provider_.reset();
  }
  void process(ipc::Block& block) override {
    data_.numSamples = block.frames;
    for (int bus = 0; bus < data_.numInputs; ++bus) {
      auto& input = data_.inputs[bus]; input.silenceFlags = 0;
      for (int c = 0; c < input.numChannels; ++c) for (unsigned f = 0; f < block.frames; ++f)
        input.channelBuffers32[c][f] = bus ? 0 : input.numChannels == 1
          ? .5f * (block.samples[f * 2] + block.samples[f * 2 + 1]) : block.samples[f * 2 + c];
    }
    for (int bus = 0; bus < data_.numOutputs; ++bus) {
      data_.outputs[bus].silenceFlags = 0;
      for (int c = 0; c < data_.outputs[bus].numChannels; ++c) std::fill_n(data_.outputs[bus].channelBuffers32[c], block.frames, 0.f);
    }
    context_ = {}; context_.sampleRate = rate_; context_.projectTimeSamples = block.samplePosition;
    context_.continousTimeSamples = block.continuousPosition; context_.tempo = block.tempo;
    context_.projectTimeMusic = block.projectTimeMusic; context_.timeSigNumerator = 4; context_.timeSigDenominator = 4;
    context_.state = ProcessContext::kTempoValid | ProcessContext::kProjectTimeMusicValid | ProcessContext::kTimeSigValid
      | ProcessContext::kContTimeValid | (block.playing ? ProcessContext::kPlaying : 0);
    changes_.clearQueue(); outputChanges_.clearQueue();
    { std::lock_guard lock(parameterMutex_); for (const auto& p : pending_) {
        int32 index = 0; if (auto* queue = changes_.addParameterData(p.first, index)) queue->addPoint(0, p.second, index);
      } pending_.clear(); }
    check(processor_->process(data_), "PLUGIN_PROCESS_FAILED");
    for (unsigned f = 0; f < block.frames; ++f) for (int c = 0; c < 2; ++c)
      block.samples[f * 2 + c] = (data_.outputs[0].silenceFlags & (1ull << std::min(c, data_.outputs[0].numChannels - 1))) ? 0
        : data_.outputs[0].channelBuffers32[std::min(c, data_.outputs[0].numChannels - 1)][f];
    updateLatency();
  }
  json info() override {
    auto info = definition_; info["inputChannels"] = data_.inputs[0].numChannels;
    info["outputChannels"] = data_.outputs[0].numChannels; info["latencyFrames"] = latency();
    info["tailSeconds"] = tailSeconds(); info["midiInput"] = false;
    IPtr<IPlugView> view = controller_ ? owned(controller_->createView(ViewType::kEditor)) : nullptr;
    info["hasEditor"] = bool(view); return info;
  }
  json parameters() override {
    json result = json::array();
    if (controller_) for (int i = 0; i < std::min(4096, controller_->getParameterCount()); ++i) {
      ParameterInfo p{}; if (controller_->getParameterInfo(i, p) != kResultOk) continue;
      result.push_back({{"id", p.id}, {"name", text16(p.title)}, {"unit", text16(p.units)},
        {"value", controller_->getParamNormalized(p.id)}, {"steps", p.stepCount}, {"readOnly", bool(p.flags & ParameterInfo::kIsReadOnly)}});
    }
    return result;
  }
  void parameter(unsigned id, double value) override {
    if (!controller_ || !std::isfinite(value) || value < 0 || value > 1) throw std::runtime_error("PLUGIN_PARAMETER_INVALID");
    check(controller_->setParamNormalized(id, value), "PLUGIN_PARAMETER_REJECTED"); performEdit(id, value);
  }
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue value) override {
    std::lock_guard lock(parameterMutex_);
    for (auto& p : pending_) if (p.first == id) { p.second = value; return kResultOk; }
    if (pending_.size() >= 4096) return kOutOfMemory;
    pending_.emplace_back(id, value); return kResultOk;
  }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    // Dynamic I/O requires a controlled rebuild, not a buffer mutation during process().
    if (flags & (kIoChanged | kReloadComponent)) incompatible_.store(true);
    return kResultOk;
  }
  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* rect) override {
    if (!rect || !window_ || rect->getWidth() < 1 || rect->getWidth() > 8192 || rect->getHeight() < 1 || rect->getHeight() > 8192) return kInvalidArgument;
    resizeEditorWindow(window_, rect->getWidth(), rect->getHeight()); return view->onSize(rect);
  }
  void editor(bool open) override {
    if (!open) { if (view_) { view_->removed(); view_->setFrame(nullptr); } if (window_) closeEditorWindow(window_); window_ = nullptr; view_ = nullptr; return; }
    if (window_) { showEditorWindow(window_); return; }
    view_ = controller_ ? owned(controller_->createView(ViewType::kEditor)) : nullptr;
    if (!view_) throw std::runtime_error("PLUGIN_EDITOR_UNAVAILABLE");
    view_->setFrame(this); window_ = openEditorWindow(view_, definition_.value("name", "Plugin"));
    if (!window_) { view_->setFrame(nullptr); view_ = nullptr; throw std::runtime_error("PLUGIN_EDITOR_OPEN_FAILED"); }
  }
  void save(const std::string& path) override {
    // Controllers queue normalized edits for process(). Flush a zero-frame
    // parameter block so saving while dry monitoring preserves the last edit.
    ipc::Block flush; flush.frames = 0; process(flush);
    ResizableMemoryIBStream processorState, controllerState;
    check(component_->getState(&processorState), "PLUGIN_STATE_SAVE_FAILED");
    if (controller_) controller_->getState(&controllerState);
    auto a = processorState.take(), b = controllerState.take();
    if (a.size() + b.size() > 64 * 1024 * 1024) throw std::runtime_error("PLUGIN_STATE_TOO_LARGE");
    auto target = filePath(path); auto temporary = target; temporary += ".tmp";
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    const std::uint32_t header[] = {0x42425354, 1, std::uint32_t(a.size()), std::uint32_t(b.size())};
    stream.write(reinterpret_cast<const char*>(header), sizeof(header));
    stream.write(reinterpret_cast<const char*>(a.data()), a.size()); stream.write(reinterpret_cast<const char*>(b.data()), b.size());
    stream.flush(); if (!stream) throw std::runtime_error("PLUGIN_STATE_WRITE_FAILED"); stream.close();
    // Content-addressed destination is new; supervisor publishes the hash only after success.
    std::filesystem::rename(temporary, target);
  }
  unsigned latency() const override { return latency_.load(); }
  double tailSeconds() const override { auto tail = processor_->getTailSamples(); return tail == kInfiniteTail ? -1 : double(tail) / rate_; }
 private:
  void updateLatency() { if (incompatible_.load()) throw std::runtime_error("PLUGIN_IO_CHANGED_RESTART_REQUIRED"); latency_.store(processor_->getLatencySamples()); }
  void restore(const std::string& path) {
    std::ifstream stream(filePath(path), std::ios::binary); std::uint32_t header[4]{};
    stream.read(reinterpret_cast<char*>(header), sizeof(header));
    if (!stream || header[0] != 0x42425354 || header[1] != 1 || std::uint64_t(header[2]) + header[3] > 64 * 1024 * 1024)
      throw std::runtime_error("PLUGIN_STATE_INVALID");
    std::vector<char> a(header[2]), b(header[3]); stream.read(a.data(), a.size()); stream.read(b.data(), b.size());
    if (!stream) throw std::runtime_error("PLUGIN_STATE_TRUNCATED");
    ResizableMemoryIBStream state; state.write(a.data(), int32(a.size()), nullptr); state.rewind();
    check(component_->setState(&state), "PLUGIN_STATE_RESTORE_FAILED");
    if (controller_) { state.rewind(); check(controller_->setComponentState(&state), "PLUGIN_CONTROLLER_RESTORE_FAILED");
      if (!b.empty()) { ResizableMemoryIBStream cs; cs.write(b.data(), int32(b.size()), nullptr); cs.rewind(); check(controller_->setState(&cs), "PLUGIN_CONTROLLER_STATE_FAILED"); } }
  }
  hosting::Module::Ptr module_;
  std::unique_ptr<PlugProvider> provider_;
  IPtr<IComponent> component_; IPtr<IEditController> controller_; IPtr<IAudioProcessor> processor_;
  IPtr<IPlugView> view_;
  HostProcessData data_; ProcessContext context_{};
  ParameterChanges changes_{4096}, outputChanges_{4096};
  std::mutex parameterMutex_; std::vector<std::pair<ParamID, ParamValue>> pending_;
  std::atomic<unsigned> latency_{0}; std::atomic<bool> incompatible_{false};
  json definition_; double rate_; bool offline_, active_ = false, processing_ = false;
  void* window_ = nullptr;
};
std::unique_ptr<Node> makeVst3(const json& config, double rate, bool offline) { return std::make_unique<VstNode>(config, rate, offline); }
json scanVst3(const std::string& path) {
  std::string error; auto module = hosting::Module::create(path, error);
  if (!module) throw std::runtime_error("PLUGIN_LOAD_FAILED:" + error);
  json result = json::array();
  for (const auto& info : module->getFactory().classInfos()) if (info.category() == kVstAudioEffectClass) {
    json item{{"format", "vst3"}, {"pluginId", info.ID().toString()}, {"path", path}, {"name", info.name()},
      {"manufacturer", info.vendor()}, {"version", info.version()}, {"category", info.subCategoriesString()},
      {"instrument", info.subCategoriesString().find("Instrument") != std::string::npos}};
    if (!item["instrument"].get<bool>()) {
      try { auto node = makeVst3(item, 48000); ipc::Block silence; node->process(silence); item.update(node->info()); item["validation"] = "available"; }
      catch (const std::exception& e) { item["validation"] = "failed"; item["failureReason"] = e.what(); }
    } else { item["validation"] = "unsupported"; item["failureReason"] = "虚拟乐器需要 MIDI 轨"; }
    result.push_back(item);
  }
  return result;
}
}
