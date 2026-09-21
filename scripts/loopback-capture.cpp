// Hardware-test helper; built into a temporary directory by test-loopback-output.mjs.
#include <RtAudio.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>

struct Capture {
  std::vector<float> samples;
  std::size_t offset = 0;
  std::atomic<unsigned> xruns{0};
};

int captureCallback(void*, void* input, unsigned frames, double, RtAudioStreamStatus status, void* pointer) {
  auto& capture = *static_cast<Capture*>(pointer);
  if (status) ++capture.xruns;
  const auto count = std::min(static_cast<std::size_t>(frames) * 8, capture.samples.size() - capture.offset);
  if (input) std::copy_n(static_cast<const float*>(input), count, capture.samples.data() + capture.offset);
  capture.offset += count;
  return 0;
}

int main(int argc, char** argv) {
  if (argc != 3) return 2;
  RtAudio audio(RtAudio::MACOSX_CORE);
  unsigned selected = 0;
  for (const auto id : audio.getDeviceIds()) {
    const auto info = audio.getDeviceInfo(id);
    if (info.name != std::string("Rogue Amoeba Software, Inc.: ") + argv[1]) continue;
    if (selected || info.inputChannels < 8) return 3;
    selected = id;
  }
  if (!selected) { std::cerr << "Expected a unique Loopback device with at least 8 input channels\n"; return 3; }
  const auto info = audio.getDeviceInfo(selected);
  const auto rate = info.currentSampleRate ? info.currentSampleRate : info.preferredSampleRate;
  Capture capture;
  capture.samples.resize(static_cast<std::size_t>(rate) * 8 * 3);
  RtAudio::StreamParameters input{selected, 8, 0};
  unsigned frames = 256;
  if (audio.openStream(nullptr, &input, RTAUDIO_FLOAT32, rate, &frames, captureCallback, &capture) != RTAUDIO_NO_ERROR) return 4;
  if (audio.startStream() != RTAUDIO_NO_ERROR) return 5;
  std::this_thread::sleep_for(std::chrono::seconds(3));
  audio.stopStream();
  audio.closeStream();
  std::ofstream file(argv[2], std::ios::binary);
  file.write(reinterpret_cast<const char*>(capture.samples.data()), static_cast<std::streamsize>(capture.offset * sizeof(float)));
  file.close();
  if (!file) return 6;
  std::cout << "{\"sampleRate\":" << rate << ",\"channels\":8,\"frames\":" << capture.offset / 8
            << ",\"xruns\":" << capture.xruns << "}\n";
}
