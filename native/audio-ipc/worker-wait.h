#pragma once
#include <algorithm>
#include <cstdint>
#include <chrono>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#include <avrt.h>
#endif

namespace bb {
// Register only the processing thread, not GUI, scanning, or offline work.
// Failure leaves ordinary scheduling intact and remains visible to diagnostics.
class AudioThreadPriority {
 public:
#ifdef _WIN32
  AudioThreadPriority() {
    DWORD task = 0;
    handle_ = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    if (!handle_) { task = 0; handle_ = AvSetMmThreadCharacteristicsW(L"Audio", &task); }
    if (handle_) AvSetMmThreadPriority(handle_, AVRT_PRIORITY_HIGH);
  }
  ~AudioThreadPriority() { if (handle_) AvRevertMmThreadCharacteristics(handle_); }
  bool active() const { return handle_ != nullptr; }
 private:
  HANDLE handle_ = nullptr;
#else
  bool active() const { return false; }
#endif
};
// Worker/probe threads only, NEVER the device callback. Windows' default
// sleep granularity can exceed the entire 512-frame IPC safety margin.
class WorkerWait {
 public:
#ifdef _WIN32
  WorkerWait() : timer_(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS)) {}
  ~WorkerWait() { if (timer_) CloseHandle(timer_); }
#endif
  void wait(std::chrono::nanoseconds duration) {
    if (duration.count() <= 0) return;
#ifdef _WIN32
    if (timer_) {
      LARGE_INTEGER due{}; due.QuadPart = -std::max<std::int64_t>(1, duration.count() / 100);
      if (SetWaitableTimer(timer_, &due, 0, nullptr, nullptr, FALSE)) { WaitForSingleObject(timer_, INFINITE); return; }
    }
#endif
    std::this_thread::sleep_for(duration);
  }
 private:
#ifdef _WIN32
  HANDLE timer_;
#endif
};
}
