#pragma once

#include <nlohmann/json.hpp>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef __APPLE__
#include <CoreAudio/CoreAudio.h>
#include <cstddef>
#endif

// Repair only Loopback's unassigned layout, when that device is selected for
// playback. Do not rewrite an intentional speaker layout or a physical device.
inline bool prepareLoopbackOutput(const nlohmann::json& deviceName) {
#ifdef __APPLE__
  const auto stringProperty = [](AudioDeviceID device, AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address{selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    CFStringRef value = nullptr;
    UInt32 size = sizeof(value);
    if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &value) != noErr || !value) return std::string{};
    const auto capacity = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
    std::vector<char> text(static_cast<std::size_t>(capacity));
    const bool ok = CFStringGetCString(value, text.data(), capacity, kCFStringEncodingUTF8);
    CFRelease(value);
    return ok ? std::string(text.data()) : std::string{};
  };
  AudioDeviceID selected = kAudioObjectUnknown;
  AudioObjectPropertyAddress address{kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  UInt32 size = sizeof(selected);
  if (deviceName.is_null()) {
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &selected) != noErr) return false;
  } else {
    address.mSelector = kAudioHardwarePropertyDevices;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) return false;
    std::vector<AudioDeviceID> devices(size / sizeof(AudioDeviceID));
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, devices.data()) != noErr) return false;
    const auto name = deviceName.get<std::string>();
    for (const auto device : devices) {
      if (stringProperty(device, kAudioObjectPropertyName) != name) continue;
      // Chromium exposes names, not CoreAudio UIDs. Never guess between two
      // identically named devices.
      if (selected != kAudioObjectUnknown) return false;
      selected = device;
    }
  }
  if (selected == kAudioObjectUnknown ||
      stringProperty(selected, kAudioDevicePropertyDeviceUID).rfind("com.rogueamoeba.Loopback::", 0) != 0) return false;

  address = {kAudioDevicePropertyPreferredChannelLayout, kAudioObjectPropertyScopeOutput, kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyDataSize(selected, &address, 0, nullptr, &size) != noErr ||
      size < offsetof(AudioChannelLayout, mChannelDescriptions)) return false;
  std::vector<UInt32> storage((size + sizeof(UInt32) - 1) / sizeof(UInt32));
  if (AudioObjectGetPropertyData(selected, &address, 0, nullptr, &size, storage.data()) != noErr) return false;
  auto* layout = reinterpret_cast<AudioChannelLayout*>(storage.data());
  const auto count = layout->mNumberChannelDescriptions;
  if (layout->mChannelLayoutTag != kAudioChannelLayoutTag_UseChannelDescriptions ||
      count <= 2 || count > 64 ||
      size < offsetof(AudioChannelLayout, mChannelDescriptions) + count * sizeof(AudioChannelDescription)) return false;
  for (UInt32 channel = 0; channel < count; ++channel) {
    if (layout->mChannelDescriptions[channel].mChannelLabel != kAudioChannelLabel_Unknown) return false;
  }
  Boolean writable = false;
  if (AudioObjectIsPropertySettable(selected, &address, &writable) != noErr || !writable) return false;
  const auto original = storage;
  for (UInt32 channel = 0; channel < count; ++channel) {
    layout->mChannelDescriptions[channel].mChannelLabel = kAudioChannelLabel_Discrete_0 + channel;
  }
  if (AudioObjectSetPropertyData(selected, &address, 0, nullptr, size, storage.data()) != noErr) {
    throw std::runtime_error("LOOPBACK_OUTPUT_LAYOUT_WRITE_FAILED");
  }
  std::vector<UInt32> verified(storage.size());
  UInt32 verifiedSize = size;
  if (AudioObjectGetPropertyData(selected, &address, 0, nullptr, &verifiedSize, verified.data()) != noErr ||
      verifiedSize != size || std::memcmp(storage.data(), verified.data(), size) != 0) {
    AudioObjectSetPropertyData(selected, &address, 0, nullptr, size, original.data());
    throw std::runtime_error("LOOPBACK_OUTPUT_LAYOUT_VERIFY_FAILED");
  }
  return true;
#else
  (void)deviceName;
  return false;
#endif
}
