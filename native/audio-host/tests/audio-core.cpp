#include "../src/realtime-safety.h"
#include "../src/input-clock.h"
#include "../src/timeline.h"
#include "../../audio-ipc/shared-audio.h"
#include "../../audio-ipc/worker-wait.h"
#include <fstream>
#include <iostream>
#include <limits>

void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void testPlaybackEq() {
  const auto config = [](double hz, double gain) { return nlohmann::json{{"enabled", true}, {"mode", "parametric"}, {"nodes", {{{"frequency", hz}, {"gainDb", gain}, {"q", 12}}}}}; };
  // A control update must not replace the audible blend mid-transition.
  bb::PlaybackEq changing, reference;
  changing.configure(config(1000, -12), 48000); reference.configure(config(1000, -12), 48000);
  changing.beginBlock(); reference.beginBlock();
  for (unsigned i = 0; i < 768; ++i) {
    float a = float(.25 * std::sin(i * 2 * 3.141592653589793 * 1000 / 48000)), b = a, c = a, d = a;
    changing.sample(a, b); reference.sample(c, d);
  }
  changing.configure(config(20, 12), 48000); changing.beginBlock(); reference.beginBlock();
  float a = .1f, b = a, c = a, d = a;
  changing.sample(a, b); reference.sample(c, d);
  require(std::abs(a - c) < 1e-6, "EQ update preserves in-flight crossfade");
  // Paused audio consumes no blocks: arbitrary pointer bursts must stay bounded
  // and the first resumed block must eventually converge to the newest target.
  bb::PlaybackEq burst;
  for (unsigned i = 0; i < 2000; ++i) burst.configure(config(1000, i % 2 ? -9 : 12), 48000);
  double power = 0;
  for (unsigned i = 0; i < 24000; ++i) {
    if (i % 128 == 0) burst.beginBlock();
    float left = float(.25 * std::sin(i * 2 * 3.141592653589793 * 1000 / 48000)), right = -left;
    burst.sample(left, right);
    require(std::isfinite(left) && std::abs(left) < .3f && left == -right, "EQ finite stereo output without clipping");
    if (i >= 12000) power += left * left;
  }
  require(std::abs(std::sqrt(power / 12000) - .25 / std::sqrt(2.) * std::pow(10., -9. / 20)) < .001, "EQ burst reaches latest target");
  for (unsigned rate : {44100u, 48000u, 96000u}) {
    bb::PlaybackEq sweep; double peak = 0, step = 0; float last = 0;
    for (unsigned i = 0; i < rate * 3; ++i) {
      if (i % 128 == 0) {
        const unsigned block = i / 128;
        auto target = config(20 * std::pow(1000., (block % 100) / 99.), block % 2 ? 12 : -12);
        if (block % 17 == 0) target = {{"enabled", false}};
        else if (block % 13 == 0) target = {{"enabled", true}, {"mode", "graphic"}, {"graphicGains", std::vector<double>(10, 12)}};
        else if (block % 11 == 0) target["nodes"] = nlohmann::json::array();
        sweep.configure(target, rate); sweep.beginBlock();
      }
      float left = float(.25 * std::sin(i * 2 * 3.141592653589793 * 1000 / rate)), right = -left;
      sweep.sample(left, right);
      require(std::isfinite(left) && left == -right, "EQ sweep preserves finite independent channels");
      peak = std::max(peak, std::abs(double(left))); step = std::max(step, std::abs(double(left - last))); last = left;
    }
    require(peak < .35 && step < .06, "EQ rapid sweep has no clipping or abrupt sample jumps");
    std::cout << nlohmann::json{{"eqSweepRate", rate}, {"seconds", 3}, {"peak", peak}, {"maximumSampleStep", step}}.dump() << '\n';
  }
}
void wave(const std::filesystem::path& path, float value, unsigned frames = 48000) {
  std::ofstream out(path, std::ios::binary); bb::writeWaveHeader(out, 48000, 2, frames * 8);
  for (unsigned i = 0; i < frames * 2; ++i) out.write(reinterpret_cast<const char*>(&value), 4);
}
int bridge(const std::filesystem::path& mapping, const std::filesystem::path& inputPath, const std::filesystem::path& outputPath, unsigned maximum = 128) {
  bb::AudioThreadPriority scheduling;
  bb::WaveReader input(inputPath); bb::ipc::Client client(mapping, maximum);
  std::ofstream out(outputPath, std::ios::binary); bb::writeWaveHeader(out, input.rate(), 2, input.frames() * 8);
  auto deadline = std::chrono::steady_clock::now();
  bb::WorkerWait idle;
  unsigned iteration = 0;
  unsigned lateCallbacks = 0; double maximumLateUs = 0;
  for (std::uint64_t position = 0; position < input.frames();) {
    const unsigned requested = (++iteration % 3 == 0) ? std::max(1u, maximum / 3) : maximum;
    std::array<float, 8192 * 2> dry{}, wet{}; const auto frames = unsigned(std::min<std::uint64_t>(requested, input.frames() - position));
    input.read(position, dry.data(), frames);
    const double lateUs = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - deadline).count();
    if (lateUs > frames * 1e6 / input.rate()) ++lateCallbacks;
    maximumLateUs = std::max(maximumLateUs, lateUs);
    client.process(dry.data(), wet.data(), frames, input.channels(), position, input.rate(), 120, true);
    out.write(reinterpret_cast<const char*>(wet.data()), frames * 8);
    position += frames;
    deadline += std::chrono::nanoseconds(std::uint64_t(frames * 1e9 / input.rate())); idle.wait(deadline - std::chrono::steady_clock::now());
  }
  std::cout << nlohmann::json{{"misses", client.misses.load()}, {"invalid", client.invalid.load()}, {"latencyFrames", client.latency()},
    {"probeLateCallbacks", lateCallbacks}, {"probeMaxLateUs", maximumLateUs}, {"realtimePriority", scheduling.active()}}.dump() << '\n';
  return 0;
}
int run(int argc, char** argv) {
  if ((argc == 5 || argc == 6) && std::string(argv[1]) == "--bridge") return bridge(std::filesystem::u8path(argv[2]), std::filesystem::u8path(argv[3]), std::filesystem::u8path(argv[4]), argc == 6 ? unsigned(std::stoul(argv[5])) : 128);
  const auto root = std::filesystem::temp_directory_path() / ("bb-core-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directories(root);
  try {
    testPlaybackEq();
    bb::OutputSafety safety;
    float samples[] = {std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN(), 2, -4, .4f, -.4f};
    safety.finish(samples, 3, 2, 48000, std::chrono::steady_clock::now());
    for (float v : samples) require(std::isfinite(v) && std::abs(v) <= .98001f, "finite output ceiling");
    require(safety.invalidSamples == 2 && safety.limitedFrames == 1, "output diagnostics");
    require(std::abs(samples[2] * 2 + samples[3]) < 1e-6, "stereo linked protection");
    nlohmann::json clocks = nlohmann::json::array();
    for (double ppm : {-800., 0., 800.}) {
      bb::InputClockBridge clock(44100, 48000, 1, 128); std::array<float, 256> in{}, out{}; in.fill(.25f);
      double inputFrames = 0; unsigned minLevel = 65536, maxLevel = 0; double maxError = 0;
      // Two minutes, distinct nominal rates plus independent +/-800 ppm drift.
      for (unsigned block = 0; block < 45000; ++block) {
        inputFrames += 128. * 44100 / 48000 * (1 + ppm / 1e6);
        const auto frames = unsigned(inputFrames); inputFrames -= frames; clock.push(in.data(), frames);
        if (clock.pull(out.data(), 128) && block > 1000) for (unsigned f = 0; f < 128; ++f) maxError = std::max(maxError, std::abs(double(out[f]) - .25));
        if (block > 1000) { minLevel = std::min(minLevel, clock.levelFrames.load()); maxLevel = std::max(maxLevel, clock.levelFrames.load()); }
      }
      require(!clock.overflows && !clock.underruns, "ASRC continuous clock drift");
      require(maxError < 1e-5 && minLevel > 128 && maxLevel < 2000, "ASRC gain and FIFO bound");
      clocks.push_back({{"ppm", ppm}, {"minimumFrames", minLevel}, {"maximumFrames", maxLevel}, {"ratio", clock.ratio.load()}});
    }
    auto a = root / "a.wav", b = root / "b.wav"; wave(a, .1f); wave(b, .2f);
    {
      // Placement is virtual: seeking to a short capture at minute 25 must
      // read only that block, with no leading-silence processing or file.
      nlohmann::json config = {{"path", a.string()}, {"durationMs", 1800000}, {"offsetMs", 1500000}, {"clockRatio", 1.001}};
      const auto started = std::chrono::steady_clock::now();
      bb::RecordingSource source(config, 48000); std::array<float, 1024> out{};
      source.read(72000000 + 12000, out.data(), 512);
      for (float sample : out) require(std::abs(sample - .1f) < 1e-6, "compact recording virtual offset and clock correction");
      require(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(250), "long song cannot gate first recording block");
      source.read(0, out.data(), 512);
      for (float sample : out) require(sample == 0, "virtual silence before recording");
      source.read(72000000 + 96000, out.data(), 512);
      for (float sample : out) require(sample == 0, "virtual silence after recording");
      config["rate"] = .75; config["pitch"] = 3;
      bb::RecordingSource stretched(config, 48000);
      stretched.read(96000000 + 16000, out.data(), 512);
      for (float sample : out) require(std::isfinite(sample), "recording stretch remains finite at arbitrary seek");
    }
    {
      const auto track = [&](const auto& file) { return nlohmann::json{{"id", "recording"}, {"gain", 1}, {"recording", {{"path", file.string()}, {"durationMs", 1000}}}}; };
      bb::Timeline timeline({{"tracks", nlohmann::json::array({track(a)})}}, 48000);
      timeline.play(); std::array<float, 256> out{};
      for (unsigned i = 0; i < 20; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
      const auto generation = timeline.state().at("generation");
      timeline.pause(); timeline.attach(nlohmann::json::array({track(b)})); timeline.update({{"tracks", {{{"id", "recording"}, {"gain", 1}}}}});
      // A paused full prefetch queue cannot retire a worker by a wall timer.
      require(timeline.state().at("sourceRevision") < timeline.state().at("requestedSourceRevision"), "paused source retains old worker until decoder transition");
      timeline.play(); float previous = .1f;
      for (unsigned i = 0; i < 110; ++i) {
        out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2));
        for (unsigned f = 0; f < 128; ++f) { require(std::abs(out[f * 2] - previous) < .002, "recording tone crossfade has no discontinuity"); previous = out[f * 2]; }
      }
      require(std::abs(previous - .2f) < 1e-6 && timeline.state().at("generation") == generation, "recording tone change preserves transport");
      require(timeline.state().at("sourceRevision") == timeline.state().at("requestedSourceRevision"), "decoder acknowledges completed recording crossfade");
      timeline.attach(nlohmann::json::array(), true); timeline.update({{"tracks", nlohmann::json::array()}});
      for (unsigned i = 0; i < 100; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
      require(std::all_of(out.begin(), out.end(), [](float value) { return value == 0; }), "deleted recording no longer reads or sounds");
    }
    {
      bb::Timeline timeline({{"tracks", {{{"id", "a"}, {"path", a.string()}, {"gain", 1}}, {{"id", "b"}, {"path", b.string()}, {"gain", 2}}}}, {"loopStartMs", 200}, {"loopEndMs", 400}}, 48000);
      timeline.play(); std::array<float, 256> out{};
      for (unsigned i = 0; i < 180; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(1)); if (i > 5) require(std::abs(out[0] - .5f) < 1e-5, "synchronous multi-track mix"); }
      require(timeline.positionMs() >= 200 && timeline.positionMs() < 400, "sample loop boundary");
      timeline.pause(); const auto before = timeline.positionMs(); timeline.mix(out.data(), 128); require(timeline.positionMs() == before, "pause freezes clock");
      timeline.seek(250); require(std::abs(timeline.positionMs() - 250) < .001, "paused seek publishes position"); timeline.play();
      for (unsigned i = 0; i < 10; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
      require(timeline.positionMs() >= 250 && timeline.positionMs() < 280, "seek discards old generation");
      const auto eqGeneration = timeline.state().at("generation"), eqUnderruns = timeline.state().at("underruns");
      for (unsigned i = 0; i < 200; ++i) {
        const nlohmann::json node = {{"frequency", 100 + i * 70}, {"gainDb", i % 2 ? -12 : 12}, {"q", 12}};
        const nlohmann::json eq = {{"enabled", true}, {"mode", "parametric"}, {"nodes", nlohmann::json::array({node})}};
        timeline.update({{"eq", eq}});
        out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2));
        for (float sample : out) require(std::isfinite(sample) && sample > 0 && sample < .7, "EQ edits preserve continuous timeline audio");
      }
      require(timeline.state().at("generation") == eqGeneration && timeline.state().at("underruns") == eqUnderruns && timeline.playing(), "EQ edits never seek or starve timeline");
    }
    {
      auto lead = root / "lead.wav", harmony = root / "harmony.wav"; wave(lead, .025f); wave(harmony, .075f);
      bb::Timeline timeline({{"tracks", {{{"id", "vocals"}, {"path", a.string()}, {"gain", 1}}}}}, 48000);
      timeline.play(); std::array<float, 256> out{};
      for (unsigned i = 0; i < 20; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
      const auto generation = timeline.state().at("generation"); const auto before = timeline.positionMs();
      timeline.attach({{{"id", "lead_vocals"}, {"path", lead.string()}}, {{"id", "backing_vocals"}, {"path", harmony.string()}}});
      timeline.update({{"tracks", {{{"id", "vocals"}, {"gain", 0}}, {{"id", "lead_vocals"}, {"gain", 1}}, {{"id", "backing_vocals"}, {"gain", 1}}}}});
      for (unsigned i = 0; i < 110; ++i) {
        out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2));
        for (float sample : out) require(std::abs(sample - .1f) < 1e-6, "vocal group crossfade preserves sum across incremental attach");
      }
      require(timeline.positionMs() > before && timeline.state().at("generation") == generation, "attach preserves running transport generation");
      timeline.update({{"tracks", {{{"id", "vocals"}, {"gain", 1}}, {{"id", "lead_vocals"}, {"gain", 0}}, {{"id", "backing_vocals"}, {"gain", 0}}}}});
      for (unsigned i = 0; i < 25; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2)); for (float sample : out) require(std::abs(sample - .1f) < 1e-6, "reverse vocal crossfade preserves sum"); }
      timeline.update({{"tracks", {{{"id", "backing_vocals"}, {"gain", 1}}}}});
      for (unsigned i = 0; i < 25; ++i) { out.fill(0); timeline.mix(out.data(), 128); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
      for (float sample : out) require(std::abs(sample - .075f) < 1e-6, "removed tracks remain silent after source refresh");
    }
    std::ostringstream large; bb::writeWaveHeader(large, 48000, 2, 0x100000008ull);
    require(large.str().size() == 80 && large.str().substr(0, 4) == "RF64" && large.str().substr(12, 4) == "ds64", "RF64 reserved header");
    std::cout << nlohmann::json{{"passed", true}, {"asrc", clocks}, {"checks", {"eq-uninterrupted-crossfade", "eq-2000-paused-edits", "eq-three-rate-sweep", "finite-stereo-protection", "asrc-120s-three-drifts", "native-multitrack", "sample-loop", "seek-generation", "vocal-attach-crossfade", "removed-track-silence", "rf64"}}}.dump() << '\n';
    std::filesystem::remove_all(root); return 0;
  } catch (...) { std::filesystem::remove_all(root); throw; }
}
#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args; for (int i = 0; i < argc; ++i) { auto s = std::filesystem::path(argv[i]).u8string(); args.emplace_back(s.begin(), s.end()); }
  std::vector<char*> pointers; for (auto& s : args) pointers.push_back(s.data());
  try { return run(argc, pointers.data()); } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
#else
int main(int argc, char** argv) { try { return run(argc, argv); } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; } }
#endif
