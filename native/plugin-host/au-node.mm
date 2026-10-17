#include "node.h"
#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AUCocoaUIView.h>
#import <Cocoa/Cocoa.h>
#include <fstream>
#include <sstream>

namespace bb::plugins {
namespace {
void require(OSStatus status, const char* operation) { if (status != noErr) throw std::runtime_error(std::string(operation) + ":" + std::to_string(status)); }
std::string cfText(CFStringRef value) {
  if (!value) return {}; char buffer[4096]{}; CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8); return buffer;
}
std::string identity(const AudioComponentDescription& d) { return std::to_string(d.componentType) + ":" + std::to_string(d.componentSubType) + ":" + std::to_string(d.componentManufacturer); }
class AuNode final : public Node {
 public:
  AuNode(const json& config, double rate, bool offline) : rate_(rate) {
    AudioComponentDescription description{}; char separator;
    std::istringstream id(config.at("pluginId").get<std::string>());
    id >> description.componentType >> separator >> description.componentSubType >> separator >> description.componentManufacturer;
    if (!id || (description.componentType != kAudioUnitType_Effect && description.componentType != kAudioUnitType_MusicEffect)) throw std::runtime_error("AU_EFFECT_ID_INVALID");
    auto component = AudioComponentFindNext(nullptr, &description);
    if (!component) throw std::runtime_error("AU_COMPONENT_MISSING");
    AudioComponentDescription actual{}; AudioComponentGetDescription(component, &actual);
    if (actual.componentFlags & kAudioComponentFlag_IsV3AudioUnit) throw std::runtime_error("AUV3_NOT_SUPPORTED");
    require(AudioComponentInstanceNew(component, &unit_), "AU_INSTANTIATE_FAILED");
    try {
      if (config.contains("statePath") && !config["statePath"].is_null()) restore(config["statePath"]);
      UInt32 maximum = ipc::quantum; require(AudioUnitSetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maximum, sizeof(maximum)), "AU_BLOCK_SIZE_FAILED");
      bool configured = false;
      for (const auto layout : {std::pair{2u, 2u}, std::pair{1u, 2u}, std::pair{1u, 1u}, std::pair{2u, 1u}}) {
        auto in = format(layout.first), out = format(layout.second);
        if (AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &in, sizeof(in)) == noErr
            && AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0, &out, sizeof(out)) == noErr) {
          inputs_ = layout.first; outputs_ = layout.second; configured = true; break;
        }
      }
      if (!configured) throw std::runtime_error("AU_LAYOUT_UNSUPPORTED");
      AURenderCallbackStruct callback{inputCallback, this}; require(AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &callback, sizeof(callback)), "AU_INPUT_CALLBACK_FAILED");
      UInt32 renderQuality = offline ? 127 : 96; AudioUnitSetProperty(unit_, kAudioUnitProperty_RenderQuality, kAudioUnitScope_Global, 0, &renderQuality, sizeof(renderQuality));
      require(AudioUnitInitialize(unit_), "AU_INITIALIZE_FAILED"); initialized_ = true;
      CFStringRef name = nullptr; AudioComponentCopyName(component, &name); name_ = cfText(name); if (name) CFRelease(name);
      UInt32 version = 0; AudioComponentGetVersion(component, &version);
      definition_ = {{"format", "auv2"}, {"pluginId", identity(actual)}, {"name", name_}, {"manufacturer", std::to_string(actual.componentManufacturer)}, {"version", std::to_string(version)}, {"instrument", false}};
    } catch (...) { AudioComponentInstanceDispose(unit_); unit_ = nullptr; throw; }
  }
  ~AuNode() override { editor(false); if (initialized_) AudioUnitUninitialize(unit_); if (unit_) AudioComponentInstanceDispose(unit_); }
  void process(ipc::Block& block) override {
    for (unsigned f = 0; f < block.frames; ++f) for (unsigned c = 0; c < inputs_; ++c)
      input_[c][f] = inputs_ == 1 ? .5f * (block.samples[f * 2] + block.samples[f * 2 + 1]) : block.samples[f * 2 + c];
    struct Buffers { UInt32 count; AudioBuffer data[2]; } buffers{}; buffers.count = outputs_;
    for (unsigned c = 0; c < outputs_; ++c) buffers.data[c] = {1, UInt32(block.frames * sizeof(float)), output_[c].data()};
    AudioTimeStamp time{}; time.mSampleTime = double(block.samplePosition); time.mFlags = kAudioTimeStampSampleTimeValid;
    AudioUnitRenderActionFlags flags = 0;
    require(AudioUnitRender(unit_, &flags, &time, 0, block.frames, reinterpret_cast<AudioBufferList*>(&buffers)), "AU_RENDER_FAILED");
    for (unsigned f = 0; f < block.frames; ++f) for (unsigned c = 0; c < 2; ++c) block.samples[f * 2 + c] = output_[std::min(c, outputs_ - 1)][f];
  }
  json info() override {
    auto info = definition_; UInt32 size = 0; Boolean writable = false;
    info["hasEditor"] = AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &size, &writable) == noErr && size >= sizeof(AudioUnitCocoaViewInfo);
    info["inputChannels"] = inputs_; info["outputChannels"] = outputs_; info["latencyFrames"] = latency(); info["tailSeconds"] = tailSeconds(); return info;
  }
  json parameters() override {
    UInt32 bytes = 0; Boolean writable; json result = json::array();
    require(AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &bytes, &writable), "AU_PARAMETER_LIST_FAILED");
    if (bytes > 4096 * sizeof(AudioUnitParameterID)) throw std::runtime_error("AU_PARAMETER_LIMIT");
    std::vector<AudioUnitParameterID> ids(bytes / sizeof(AudioUnitParameterID));
    require(AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, ids.data(), &bytes), "AU_PARAMETER_LIST_FAILED");
    for (auto id : ids) {
      AudioUnitParameterInfo info{}; UInt32 size = sizeof(info); if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &info, &size) != noErr) continue;
      AudioUnitParameterValue value = 0; AudioUnitGetParameter(unit_, id, kAudioUnitScope_Global, 0, &value);
      const std::string name = info.flags & kAudioUnitParameterFlag_HasCFNameString ? cfText(info.cfNameString) : info.name;
      result.push_back({{"id", id}, {"name", name}, {"unit", ""}, {"steps", 0}, {"readOnly", !(info.flags & kAudioUnitParameterFlag_IsWritable)},
        {"value", info.maxValue > info.minValue ? std::clamp(double(value - info.minValue) / (info.maxValue - info.minValue), 0., 1.) : 0}});
      if ((info.flags & kAudioUnitParameterFlag_CFNameRelease) && info.cfNameString) CFRelease(info.cfNameString);
    }
    return result;
  }
  void parameter(unsigned id, double value) override {
    AudioUnitParameterInfo info{}; UInt32 size = sizeof(info);
    require(AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &info, &size), "AU_PARAMETER_MISSING");
    if (!std::isfinite(value) || value < 0 || value > 1) throw std::runtime_error("AU_PARAMETER_INVALID");
    require(AudioUnitSetParameter(unit_, id, kAudioUnitScope_Global, 0, info.minValue + value * (info.maxValue - info.minValue), 0), "AU_PARAMETER_FAILED");
    if ((info.flags & kAudioUnitParameterFlag_CFNameRelease) && info.cfNameString) CFRelease(info.cfNameString);
  }
  void save(const std::string& path) override {
    CFPropertyListRef state = nullptr; UInt32 size = sizeof(state);
    require(AudioUnitGetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &state, &size), "AU_STATE_FAILED");
    auto data = CFPropertyListCreateData(nullptr, state, kCFPropertyListBinaryFormat_v1_0, 0, nullptr); CFRelease(state);
    if (!data) throw std::runtime_error("AU_STATE_ENCODE_FAILED");
    auto destination = std::filesystem::u8path(path), temporary = destination; temporary += ".tmp";
    std::ofstream file(temporary, std::ios::binary); file.write(reinterpret_cast<const char*>(CFDataGetBytePtr(data)), CFDataGetLength(data)); CFRelease(data);
    file.flush(); if (!file) throw std::runtime_error("AU_STATE_WRITE_FAILED"); file.close(); std::filesystem::rename(temporary, destination);
  }
  void editor(bool open) override {
    if (!open) { if (window_) { [window_ close]; [window_ release]; window_ = nil; } return; }
    if (window_) { [window_ makeKeyAndOrderFront:nil]; return; }
    UInt32 size = 0; Boolean writable;
    require(AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &size, &writable), "AU_EDITOR_UNAVAILABLE");
    if (size < sizeof(AudioUnitCocoaViewInfo) || size > 65536) throw std::runtime_error("AU_EDITOR_INVALID");
    std::vector<char> memory(size); auto* info = reinterpret_cast<AudioUnitCocoaViewInfo*>(memory.data());
    require(AudioUnitGetProperty(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, info, &size), "AU_EDITOR_FAILED");
    NSBundle* bundle = [NSBundle bundleWithURL:(NSURL*)info->mCocoaAUViewBundleLocation]; [bundle load];
    Class factoryClass = NSClassFromString((NSString*)info->mCocoaAUViewClass[0]);
    id<AUCocoaUIBase> factory = [[factoryClass alloc] init]; NSView* view = [factory uiViewForAudioUnit:unit_ withSize:NSMakeSize(640, 480)]; [factory release];
    const unsigned classes = unsigned((size - offsetof(AudioUnitCocoaViewInfo, mCocoaAUViewClass)) / sizeof(CFStringRef));
    CFRelease(info->mCocoaAUViewBundleLocation); for (unsigned i = 0; i < classes; ++i) CFRelease(info->mCocoaAUViewClass[i]);
    if (!view) throw std::runtime_error("AU_EDITOR_UNAVAILABLE");
    window_ = [[NSWindow alloc] initWithContentRect:[view frame] styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    [window_ setReleasedWhenClosed:NO]; [window_ setContentView:view]; [window_ setTitle:[NSString stringWithUTF8String:name_.c_str()]]; [window_ center]; [window_ makeKeyAndOrderFront:nil];
  }
  unsigned latency() const override { return unsigned(std::max(0., property(kAudioUnitProperty_Latency)) * rate_); }
  double tailSeconds() const override { return property(kAudioUnitProperty_TailTime); }
 private:
  double property(AudioUnitPropertyID id) const { Float64 value = 0; UInt32 size = sizeof(value); AudioUnitGetProperty(unit_, id, kAudioUnitScope_Global, 0, &value, &size); return std::isfinite(value) ? value : -1; }
  AudioStreamBasicDescription format(unsigned channels) const { AudioStreamBasicDescription f{}; f.mSampleRate = rate_; f.mFormatID = kAudioFormatLinearPCM; f.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved; f.mBytesPerPacket = f.mBytesPerFrame = 4; f.mFramesPerPacket = 1; f.mChannelsPerFrame = channels; f.mBitsPerChannel = 32; return f; }
  static OSStatus inputCallback(void* context, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames, AudioBufferList* buffers) {
    auto& self = *static_cast<AuNode*>(context); if (frames > ipc::quantum || buffers->mNumberBuffers != self.inputs_) return kAudio_ParamError;
    for (unsigned c = 0; c < self.inputs_; ++c) { buffers->mBuffers[c].mNumberChannels = 1; buffers->mBuffers[c].mDataByteSize = frames * 4;
      if (buffers->mBuffers[c].mData) std::memcpy(buffers->mBuffers[c].mData, self.input_[c].data(), frames * 4); else buffers->mBuffers[c].mData = self.input_[c].data(); }
    return noErr;
  }
  void restore(const std::string& path) {
    std::ifstream file(std::filesystem::u8path(path), std::ios::binary); std::vector<char> bytes((std::istreambuf_iterator<char>(file)), {});
    if (bytes.empty() || bytes.size() > 64 * 1024 * 1024) throw std::runtime_error("AU_STATE_INVALID");
    auto data = CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(bytes.data()), bytes.size());
    auto state = CFPropertyListCreateWithData(nullptr, data, kCFPropertyListImmutable, nullptr, nullptr); CFRelease(data);
    if (!state) throw std::runtime_error("AU_STATE_INVALID"); auto status = AudioUnitSetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &state, sizeof(state)); CFRelease(state); require(status, "AU_STATE_RESTORE_FAILED");
  }
  AudioUnit unit_ = nullptr; bool initialized_ = false; double rate_; unsigned inputs_ = 2, outputs_ = 2;
  std::array<std::array<float, ipc::quantum>, 2> input_{}, output_{};
  json definition_; std::string name_; NSWindow* window_ = nil;
};
}
std::unique_ptr<Node> makeAu(const json& config, double rate, bool offline) { return std::make_unique<AuNode>(config, rate, offline); }
json enumerateAu() {
  json result = json::array();
  for (auto type : {kAudioUnitType_Effect, kAudioUnitType_MusicEffect}) {
    AudioComponentDescription description{}; description.componentType = type; AudioComponent component = nullptr;
    while ((component = AudioComponentFindNext(component, &description))) {
      AudioComponentDescription d{}; AudioComponentGetDescription(component, &d); if (d.componentFlags & kAudioComponentFlag_IsV3AudioUnit) continue;
      CFStringRef name = nullptr; AudioComponentCopyName(component, &name); UInt32 version = 0; AudioComponentGetVersion(component, &version);
      result.push_back({{"format", "auv2"}, {"pluginId", identity(d)}, {"path", "au:" + identity(d)}, {"name", cfText(name)}, {"version", std::to_string(version)}, {"instrument", false}}); if (name) CFRelease(name);
    }
  }
  return result;
}
json scanAu(const std::string& id) { auto node = makeAu({{"pluginId", id}}, 48000, false); ipc::Block silence; node->process(silence); auto info = node->info(); info["validation"] = "available"; info["path"] = "au:" + id; return json::array({info}); }
}
