#include "realtime-audio.h"
#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#include <mmsystem.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <avrt.h>
#define BB_EXPORT extern "C" __declspec(dllexport)
#else
#define BB_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace bb::realtime {
#ifdef _WIN32
using Microsoft::WRL::ComPtr;
double clockSeconds() { LARGE_INTEGER n, f; QueryPerformanceCounter(&n); QueryPerformanceFrequency(&f); return double(n.QuadPart) / f.QuadPart; }
void check(HRESULT hr) { if (FAILED(hr)) throw std::runtime_error("WASAPI_ERROR_" + std::to_string(static_cast<unsigned>(hr))); }
std::string utf8(const wchar_t* value) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0'); WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr, nullptr); out.pop_back(); return out;
}
std::wstring wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  std::wstring out(size, L'\0'); MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, out.data(), size); out.pop_back(); return out;
}
struct ComScope { ComScope() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); } ~ComScope() { CoUninitialize(); } };
struct TimerScope {
  bool active = timeBeginPeriod(1) == TIMERR_NOERROR;
  ~TimerScope() { if (active) timeEndPeriod(1); }
};
ComPtr<IMMDeviceEnumerator> enumerator() { ComPtr<IMMDeviceEnumerator> p; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&p))); return p; }
Json devices() {
  ComScope com; auto e = enumerator(); ComPtr<IMMDeviceCollection> list;
  check(e->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &list)); UINT count; check(list->GetCount(&count));
  Json result = Json::array();
  for (UINT i = 0; i < count; ++i) {
    ComPtr<IMMDevice> d; check(list->Item(i, &d)); LPWSTR id; check(d->GetId(&id)); std::string key = utf8(id); CoTaskMemFree(id);
    ComPtr<IPropertyStore> props; check(d->OpenPropertyStore(STGM_READ, &props)); PROPVARIANT name; PropVariantInit(&name);
    check(props->GetValue(PKEY_Device_FriendlyName, &name)); const auto label = utf8(name.pwszVal); PropVariantClear(&name);
    result.push_back({{"id", key}, {"name", label}, {"input", true}, {"output", true}, {"kind", "loopback"}});
  }
  return result;
}
struct Wasapi {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  ComPtr<IAudioRenderClient> render;
  ComPtr<IAudioClock> clock;
  UINT64 clockFrequency = 0;
  UINT32 size = 0; double latency = 0; bool started = false;
  Wasapi(IMMDeviceEnumerator* e, const std::string& id, unsigned rate, bool input) {
    ComPtr<IMMDevice> device; check(e->GetDevice(wide(id).c_str(), &device));
    check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client));
    WAVEFORMATEX f{}; f.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; f.nChannels = 2; f.nSamplesPerSec = rate;
    f.wBitsPerSample = 32; f.nBlockAlign = 8; f.nAvgBytesPerSec = rate * 8;
    const DWORD flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY | (input ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0);
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &f, nullptr));
    check(client->GetBufferSize(&size)); REFERENCE_TIME delay; check(client->GetStreamLatency(&delay)); latency = delay / 10000000.0;
    if (input) check(client->GetService(IID_PPV_ARGS(&capture)));
    else {
      check(client->GetService(IID_PPV_ARGS(&render))); check(client->GetService(IID_PPV_ARGS(&clock)));
      check(clock->GetFrequency(&clockFrequency));
      if (!clockFrequency) throw std::runtime_error("DEVICE_CLOCK_UNAVAILABLE");
    }
  }
  void start() { check(client->Start()); started = true; }
  ~Wasapi() { if (started) client->Stop(); }
};
void run(Engine& e, const Json& c) {
  ComScope com; TimerScope timer; auto devices = enumerator();
  if (c.value("probeOnly", false)) {
    Wasapi generator(devices.Get(), c.at("output"), e.rate, false); generator.start(); e.opened = true;
    while (!e.stop) {
      UINT32 padding; check(generator.client->GetCurrentPadding(&padding)); const auto count = generator.size - padding;
      if (count) {
        BYTE* bytes; check(generator.render->GetBuffer(count, &bytes)); auto* samples = reinterpret_cast<float*>(bytes);
        for (unsigned i = 0; i < count; ++i) { const auto value = probe(e.generated++, e.rate); samples[2*i] = value; samples[2*i+1] = value; }
        check(generator.render->ReleaseBuffer(count, 0));
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return;
  }
  Wasapi input(devices.Get(), c.at("source"), e.rate, true), output(devices.Get(), c.at("output"), e.rate, false);
  // A silent render stream keeps WASAPI loopback clocks advancing when the
  // external player is paused. Test mode substitutes the known probe signal.
  auto test = std::make_unique<Wasapi>(devices.Get(), c.at("source"), e.rate, false);
  const bool testing = c.value("test", false);
  DWORD task = 0; HANDLE priority = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  struct Priority { HANDLE h; ~Priority() { if (h) AvRevertMmThreadCharacteristics(h); } } scope{priority};
  input.start(); output.start(); if (test) test->start(); e.opened = true;
  bool deviceStarving = false;
  double submittedFrames = 0;
  while (!e.stop) {
    UINT32 count = 0; check(input.capture->GetNextPacketSize(&count));
    while (count) {
      BYTE* bytes; DWORD flags; UINT64 pos, qpc;
      check(input.capture->GetBuffer(&bytes, &count, &flags, &pos, &qpc));
      if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ++e.clockErrors;
      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY && e.captured > 0) ++e.drops;
      const auto* samples = reinterpret_cast<float*>(bytes);
      for (unsigned i = 0; i < count; ++i) {
        const bool silent = flags & AUDCLNT_BUFFERFLAGS_SILENT;
        e.capture(silent ? 0 : samples[2*i], silent ? 0 : samples[2*i+1], qpc / 10000000.0 + double(i) / e.rate);
      }
      check(input.capture->ReleaseBuffer(count)); check(input.capture->GetNextPacketSize(&count));
    }
    UINT32 padding; check(output.client->GetCurrentPadding(&padding)); const auto available = output.size - padding;
    UINT64 position, qpc;
    check(output.clock->GetPosition(&position, &qpc));
    if (!qpc) ++e.clockErrors;
    const double playedFrames = double(position) * e.rate / output.clockFrequency;
    // Zero padding alone also occurs exactly at a normal buffer boundary.
    // Count starvation only when the hardware clock has actually advanced
    // beyond all submitted audio (one frame permits integer rounding).
    const bool gap = e.started && playedFrames > submittedFrames + 1;
    if (gap && !deviceStarving) ++e.underruns;
    deviceStarving = gap;
    submittedFrames = std::max(submittedFrames, playedFrames);
    if (available) {
      BYTE* bytes; check(output.render->GetBuffer(available, &bytes)); auto* out = reinterpret_cast<float*>(bytes);
      const double dac = qpc / 10000000.0 + (submittedFrames - playedFrames) / e.rate + output.latency;
      for (unsigned i = 0; i < available; ++i) { const auto f = e.render(dac + double(i) / e.rate); out[2*i] = f.left; out[2*i+1] = f.right; }
      check(output.render->ReleaseBuffer(available, 0));
      submittedFrames += available;
    }
    if (test) {
      check(test->client->GetCurrentPadding(&padding)); const auto availableTest = test->size - padding;
      if (availableTest) {
        BYTE* bytes; check(test->render->GetBuffer(availableTest, &bytes)); auto* out = reinterpret_cast<float*>(bytes);
        for (unsigned i = 0; i < availableTest; ++i) { const float value = testing ? probe(e.generated++, e.rate) : 0; out[2*i] = value; out[2*i+1] = value; }
        check(test->render->ReleaseBuffer(availableTest, testing ? 0 : AUDCLNT_BUFFERFLAGS_SILENT));
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
}
#endif
static std::unique_ptr<Engine> engine;
static std::thread audioThread;
static std::string response;
}
using namespace bb::realtime;
BB_EXPORT const char* bb_devices() { try { response = devices().dump(); } catch (const std::exception& ex) { response = Json({{"error", ex.what()}}).dump(); } return response.c_str(); }
BB_EXPORT void bb_close() {
  if (engine) engine->stop = true;
  if (audioThread.joinable()) audioThread.join();
  engine.reset();
}
BB_EXPORT const char* bb_open(const char* config) {
  bb_close();
  try {
    auto c = Json::parse(config); engine = std::make_unique<Engine>(); engine->rate = c.at("rate");
    if (engine->rate != 44100 && engine->rate != 48000) throw std::runtime_error("UNSUPPORTED_RATE");
    if (c.at("source") == c.at("output")) throw std::runtime_error("SOURCE_OUTPUT_MUST_DIFFER");
    audioThread = std::thread([c] { try { run(*engine, c); } catch (const std::exception& ex) { engine->error = ex.what(); engine->failed.store(true, std::memory_order_release); } });
    response = "{}";
  } catch (const std::exception& ex) { response = Json({{"error", ex.what()}}).dump(); }
  return response.c_str();
}
BB_EXPORT unsigned bb_read(float* samples, double* times, unsigned maximum) {
  if (!engine) return 0; unsigned n = 0; Frame f;
  while (n < maximum && engine->input.pop(f)) { samples[2*n] = f.left; samples[2*n+1] = f.right; times[n++] = f.time; }
  return n;
}
BB_EXPORT unsigned bb_write(const float* samples, unsigned count, double firstTime, double timeStep) {
  if (!engine || count > capacity) return 0;
  unsigned n = 0;
  for (; n < count; ++n) {
    if (!std::isfinite(samples[2*n]) || !std::isfinite(samples[2*n+1])) { ++engine->overflows; break; }
    if (!engine->output.push({samples[2*n], samples[2*n+1], firstTime + n * timeStep})) { ++engine->overflows; break; }
  }
  return n;
}
BB_EXPORT const char* bb_stats() {
  if (!engine) { response = "{}"; return response.c_str(); }
  auto& e = *engine;
  response = Json({{"opened", e.opened.load()}, {"error", e.failed.load(std::memory_order_acquire) ? e.error : ""},
    {"captured", e.captured.load()}, {"rendered", e.rendered.load()}, {"generated", e.generated.load()},
    {"inputDrops", e.drops.load()}, {"underruns", e.underruns.load()}, {"overflows", e.overflows.load()}, {"clockErrors", e.clockErrors.load()},
    {"inputFrames", e.input.size()}, {"outputFrames", e.output.size()}, {"latencyMs", e.latency.load()}, {"maxLatencyMs", e.maxLatency.load()}}).dump();
  return response.c_str();
}
