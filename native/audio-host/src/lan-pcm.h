#pragma once
#include <signalsmith-stretch/signalsmith-stretch.h>
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace bb {
// Private pipe protocol. One process owns both continuous stereo processors;
// no audio device, temporary WAV or encoder is involved.
inline int runLanPcm() {
  try {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::string line;
    if (!std::getline(std::cin, line) || line.size() > 16384) return 1;
    const auto config = nlohmann::json::parse(line);
    const auto drums = config.at("drums").get<std::vector<bool>>();
    const unsigned tracks = unsigned(drums.size());
    const double rate = config.at("rate"), pitch = config.at("pitch");
    if (!tracks || tracks > 16 || !std::isfinite(rate) || rate < .5 || rate > 2 || !std::isfinite(pitch) || std::abs(pitch) > 12) throw std::runtime_error("LAN_PCM_CONFIG");
    using Stretch = signalsmith::stretch::SignalsmithStretch<float>;
    Stretch harmonic, percussion;
    harmonic.presetDefault(2, 48000); percussion.presetDefault(2, 48000);
    harmonic.setTransposeSemitones(pitch, 8000. / 48000);
    // This bus contains instruments as well as vocals. Voice-formant locking
    // on the entire mix can suppress pitched instrument fundamentals.
    harmonic.setFormantSemitones(0, false);
    const bool transform = rate != 1 || pitch != 0;
    const unsigned prime = transform ? harmonic.outputSeekLength(float(rate)) : 0;
    std::cout << "{\"primeFrames\":" << prime << "}\n" << std::flush;
    std::vector<float> gains(tracks, 0), target(tracks);
    bool primed = !transform, first = true;
    for (;;) {
      std::array<std::uint32_t, 2> header{};
      if (!std::cin.read(reinterpret_cast<char*>(header.data()), sizeof(header))) break;
      const auto inFrames = header[0], outFrames = header[1];
      if (inFrames > 32768 || outFrames > 4096 || (!outFrames && (primed || inFrames != prime))) throw std::runtime_error("LAN_PCM_BLOCK");
      if (!transform && inFrames != outFrames) throw std::runtime_error("LAN_PCM_FRAME_MISMATCH");
      if (!std::cin.read(reinterpret_cast<char*>(target.data()), tracks * sizeof(float))) throw std::runtime_error("LAN_PCM_GAIN_EOF");
      for (auto value : target) if (!std::isfinite(value) || value < 0 || value > 64) throw std::runtime_error("LAN_PCM_GAIN");
      if (first) { gains = target; first = false; }
      std::vector<float> input(std::size_t(inFrames) * tracks * 2);
      if (!std::cin.read(reinterpret_cast<char*>(input.data()), std::streamsize(input.size() * sizeof(float)))) throw std::runtime_error("LAN_PCM_INPUT_EOF");
      std::array<std::vector<float>, 2> h, d, ho, dout;
      for (unsigned c = 0; c < 2; ++c) { h[c].resize(inFrames); d[c].resize(inFrames); ho[c].resize(outFrames); dout[c].resize(outFrames); }
      for (unsigned f = 0; f < inFrames; ++f) for (unsigned t = 0; t < tracks; ++t) {
        // A gain ramp is continuous across requests, including rapid slider moves.
        gains[t] += std::clamp(target[t] - gains[t], -1.f / 1680, 1.f / 1680);
        auto& bus = drums[t] ? d : h;
        for (unsigned c = 0; c < 2; ++c) bus[c][f] += input[(std::size_t(f) * tracks + t) * 2 + c] * gains[t];
      }
      if (!outFrames) {
        harmonic.outputSeek(h, inFrames); percussion.outputSeek(d, inFrames); primed = true;
        continue;
      }
      if (!primed) throw std::runtime_error("LAN_PCM_NOT_PRIMED");
      if (transform) { harmonic.process(h, inFrames, ho, outFrames); percussion.process(d, inFrames, dout, outFrames); }
      std::vector<float> output(std::size_t(outFrames) * 2);
      for (unsigned f = 0; f < outFrames; ++f) for (unsigned c = 0; c < 2; ++c) {
        float value = transform ? ho[c][f] + dout[c][f] : h[c][f] + d[c][f];
        if (!std::isfinite(value)) throw std::runtime_error("LAN_PCM_NONFINITE");
        output[f * 2 + c] = value;
      }
      std::cout.write(reinterpret_cast<const char*>(output.data()), std::streamsize(output.size() * sizeof(float)));
      std::cout.flush();
      if (!std::cout) return 0;
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
}
