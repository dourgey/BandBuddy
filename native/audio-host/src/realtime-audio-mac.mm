#include "realtime-audio.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <mach/mach_time.h>
#include <thread>
#include <chrono>
#include <unistd.h>
#include <libproc.h>
#include <memory>
#include <vector>

namespace bb::realtime {
double clockSeconds() { mach_timebase_info_data_t t; mach_timebase_info(&t); return double(mach_absolute_time()) * t.numer / t.denom / 1e9; }
double hostSeconds(uint64_t value) { mach_timebase_info_data_t t; mach_timebase_info(&t); return double(value) * t.numer / t.denom / 1e9; }
void check(OSStatus status) { if (status) throw std::runtime_error("COREAUDIO_ERROR_" + std::to_string(status)); }
template<class T> T property(AudioObjectID object, AudioObjectPropertySelector key, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  T value{}; UInt32 size = sizeof(value); AudioObjectPropertyAddress a{key, scope, kAudioObjectPropertyElementMain};
  check(AudioObjectGetPropertyData(object, &a, 0, nullptr, &size, &value)); return value;
}
std::string textProperty(AudioObjectID object, AudioObjectPropertySelector key) {
  CFStringRef text = property<CFStringRef>(object, key); char bytes[2048]{};
  if (text) { CFStringGetCString(text, bytes, sizeof(bytes), kCFStringEncodingUTF8); CFRelease(text); } return bytes;
}
unsigned channels(AudioObjectID device, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress a{kAudioDevicePropertyStreamConfiguration, scope, kAudioObjectPropertyElementMain}; UInt32 size = 0;
  check(AudioObjectGetPropertyDataSize(device, &a, 0, nullptr, &size)); std::vector<char> bytes(size);
  auto* list = reinterpret_cast<AudioBufferList*>(bytes.data()); check(AudioObjectGetPropertyData(device, &a, 0, nullptr, &size, list));
  unsigned count = 0; for (unsigned i = 0; i < list->mNumberBuffers; ++i) count += list->mBuffers[i].mNumberChannels; return count;
}
Json devices() {
  AudioObjectPropertyAddress a{kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain}; UInt32 size = 0;
  check(AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, nullptr, &size)); std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  check(AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, nullptr, &size, ids.data())); Json result = Json::array();
  if (@available(macOS 14.2, *)) result.push_back({{"id", "system-tap"}, {"name", "电脑系统音频"}, {"input", true}, {"output", false}, {"kind", "tap"}});
  for (auto id : ids) {
    result.push_back({{"id", textProperty(id, kAudioDevicePropertyDeviceUID)}, {"name", textProperty(id, kAudioObjectPropertyName)},
      {"input", channels(id, kAudioObjectPropertyScopeInput) >= 2}, {"output", channels(id, kAudioObjectPropertyScopeOutput) >= 2},
      {"rate", property<Float64>(id, kAudioDevicePropertyNominalSampleRate)}, {"kind", "device"}});
  }
  return result;
}
AudioDeviceID findDevice(const std::string& uid) {
  NSString* text = [NSString stringWithUTF8String:uid.c_str()]; CFStringRef cf = (__bridge CFStringRef)text;
  AudioDeviceID id = 0; AudioValueTranslation v{&cf, sizeof(cf), &id, sizeof(id)}; UInt32 size = sizeof(v);
  AudioObjectPropertyAddress a{kAudioHardwarePropertyDeviceForUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  check(AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, nullptr, &size, &v)); if (!id) throw std::runtime_error("DEVICE_MISSING"); return id;
}
struct Tap {
  AudioObjectID tap = 0; AudioDeviceID aggregate = 0;
  ~Tap() { if (@available(macOS 14.2, *)) { if (aggregate) AudioHardwareDestroyAggregateDevice(aggregate); if (tap) AudioHardwareDestroyProcessTap(tap); } }
  void open(const Json& config) {
    if (@available(macOS 14.2, *)) {
      NSMutableArray<NSNumber*>* excluded = [NSMutableArray array];
      auto pids = config.value("excludePids", std::vector<int>{}); pids.push_back(getpid());
      // Electron metrics do not include native audio/plugin children. Include
      // every current descendant so their playback cannot feed the tap.
      AudioObjectPropertyAddress processList{kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
      UInt32 processBytes = 0;
      check(AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &processList, 0, nullptr, &processBytes));
      std::vector<AudioObjectID> processes(processBytes / sizeof(AudioObjectID));
      check(AudioObjectGetPropertyData(kAudioObjectSystemObject, &processList, 0, nullptr, &processBytes, processes.data()));
      for (const auto object : processes) {
        const auto pid = property<pid_t>(object, kAudioProcessPropertyPID);
        auto ancestor = pid;
        for (unsigned depth = 0; ancestor > 1 && depth < 32; ++depth) {
          if (std::find(pids.begin(), pids.end(), ancestor) != pids.end()) { [excluded addObject:@(object)]; break; }
          proc_bsdinfo info{};
          if (proc_pidinfo(ancestor, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) break;
          ancestor = info.pbi_ppid;
        }
      }
      for (auto pid : pids) {
        AudioObjectID id = 0; UInt32 size = sizeof(id); pid_t process = pid;
        AudioObjectPropertyAddress a{kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
        if (!AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof(process), &process, &size, &id) && id) [excluded addObject:@(id)];
      }
      CATapDescription* description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:excluded];
      description.name = @"BandBuddy 实时分轨"; description.privateTap = YES; description.muteBehavior = CATapMutedWhenTapped;
      check(AudioHardwareCreateProcessTap(description, &tap));
      NSDictionary* spec = @{ @kAudioAggregateDeviceNameKey: @"BandBuddy Realtime Capture", @kAudioAggregateDeviceUIDKey: [[NSUUID UUID] UUIDString],
        @kAudioAggregateDeviceIsPrivateKey: @YES, @kAudioAggregateDeviceTapAutoStartKey: @YES,
        @kAudioAggregateDeviceTapListKey: @[@{@kAudioSubTapUIDKey: description.UUID.UUIDString, @kAudioSubTapDriftCompensationKey: @YES}] };
      check(AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)spec, &aggregate));
    } else throw std::runtime_error("MACOS_TAP_REQUIRES_14_2");
  }
};
struct Stream {
  Engine& engine; AudioDeviceID device; bool input, generator; AudioDeviceIOProcID proc = nullptr; bool active = false; double delay = 0;
  Stream(Engine& e, AudioDeviceID id, bool capture, bool generate = false) : engine(e), device(id), input(capture), generator(generate) {
    const auto scope = input ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput;
    auto format = property<AudioStreamBasicDescription>(device, kAudioDevicePropertyStreamFormat, scope);
    if (std::abs(format.mSampleRate - engine.rate) > 1 || !(format.mFormatFlags & kAudioFormatFlagIsFloat) || format.mBitsPerChannel != 32)
      throw std::runtime_error("DEVICE_FORMAT_MUST_MATCH_RATE_FLOAT32");
    delay = (property<UInt32>(device, kAudioDevicePropertyLatency, scope) + property<UInt32>(device, kAudioDevicePropertySafetyOffset, scope)) / double(engine.rate);
    check(AudioDeviceCreateIOProcID(device, callback, this, &proc));
  }
  static OSStatus callback(AudioDeviceID, const AudioTimeStamp*, const AudioBufferList* in, const AudioTimeStamp* inTime, AudioBufferList* out, const AudioTimeStamp* outTime, void* context) {
    auto& s = *static_cast<Stream*>(context); auto& e = s.engine;
    const auto* list = s.input ? in : out;
    if (!list || !list->mNumberBuffers || !list->mBuffers[0].mNumberChannels) return noErr;
    const unsigned frames = list->mBuffers[0].mDataByteSize / (sizeof(float) * list->mBuffers[0].mNumberChannels);
    const auto* stamp = s.input ? inTime : outTime;
    if (!stamp || !(stamp->mFlags & kAudioTimeStampHostTimeValid)) { ++e.clockErrors; return noErr; }
    const double time = hostSeconds(stamp->mHostTime) + (s.input ? -s.delay : s.delay);
    for (unsigned f = 0; f < frames; ++f) {
      Frame value;
      if (!s.input) { if (s.generator) value.left = value.right = probe(e.generated++, e.rate); else value = e.render(time + f / double(e.rate)); }
      unsigned channel = 0;
      for (unsigned b = 0; b < list->mNumberBuffers; ++b) {
        const auto& buffer = list->mBuffers[b]; auto* data = static_cast<float*>(buffer.mData); if (!data) continue;
        for (unsigned c = 0; c < buffer.mNumberChannels; ++c, ++channel) {
          const auto index = f * buffer.mNumberChannels + c;
          if (s.input) { if (channel == 0) value.left = data[index]; if (channel == 1) value.right = data[index]; }
          else data[index] = channel == 0 ? value.left : channel == 1 ? value.right : 0;
        }
      }
      if (s.input) e.capture(value.left, value.right, time + f / double(e.rate));
    }
    return noErr;
  }
  void start() { check(AudioDeviceStart(device, proc)); active = true; }
  ~Stream() { if (active) AudioDeviceStop(device, proc); if (proc) AudioDeviceDestroyIOProcID(device, proc); }
};
void run(Engine& e, const Json& c) {
  @autoreleasepool {
    if (c.value("probeOnly", false)) {
      Stream generator(e, findDevice(c.at("output")), false, true); generator.start(); e.opened = true;
      while (!e.stop) std::this_thread::sleep_for(std::chrono::milliseconds(10)); return;
    }
    // Register our output process with Core Audio before constructing the tap's
    // exclusion list. Otherwise a newly spawned worker has no process object.
    Stream output(e, findDevice(c.at("output")), false); output.start();
    Tap tap; AudioDeviceID inputId;
    if (c.at("source") == "system-tap") { tap.open(c); inputId = tap.aggregate; } else inputId = findDevice(c.at("source"));
    Stream input(e, inputId, true);
    std::unique_ptr<Stream> generator;
    if (c.value("test", false) && c.at("source") != "system-tap") generator = std::make_unique<Stream>(e, inputId, false, true);
    input.start(); if (generator) generator->start(); e.opened = true;
    while (!e.stop) {
      if (!property<UInt32>(inputId, kAudioDevicePropertyDeviceIsAlive) || !property<UInt32>(output.device, kAudioDevicePropertyDeviceIsAlive)) throw std::runtime_error("DEVICE_DISCONNECTED");
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }
}
}
