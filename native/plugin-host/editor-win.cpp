#include "node.h"
#include "pluginterfaces/gui/iplugview.h"
#include <windows.h>
#include <objbase.h>
namespace bb::plugins {
using namespace Steinberg;
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_CLOSE) { ShowWindow(window, SW_HIDE); return 0; }
  return DefWindowProcW(window, message, w, l);
}
void initializePlatform() {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW type{}; type.lpfnWndProc = procedure; type.hInstance = GetModuleHandleW(nullptr);
  type.lpszClassName = L"BandBuddyPluginEditor"; type.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassW(&type);
}
void pumpPlatform() {
  MSG message{}; while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
}
void resizeEditorWindow(void* pointer, int width, int height) {
  const auto window = static_cast<HWND>(pointer);
  RECT r{0, 0, width, height}; AdjustWindowRect(&r, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE);
  SetWindowPos(window, nullptr, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER);
}
void* openEditorWindow(void* pointer, const std::string& title) {
  auto* view = static_cast<IPlugView*>(pointer);
  if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return nullptr;
  const auto count = MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, nullptr, 0);
  std::wstring text(count, 0); MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, text.data(), count);
  auto window = CreateWindowW(L"BandBuddyPluginEditor", text.c_str(), WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
    CW_USEDEFAULT, CW_USEDEFAULT, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!window) return nullptr;
  if (view->attached(window, kPlatformTypeHWND) != kResultTrue) { DestroyWindow(window); return nullptr; }
  ViewRect rect{}; if (view->getSize(&rect) == kResultTrue) resizeEditorWindow(window, rect.getWidth(), rect.getHeight());
  ShowWindow(window, SW_SHOW); return window;
}
void showEditorWindow(void* window) { ShowWindow(static_cast<HWND>(window), SW_RESTORE); SetForegroundWindow(static_cast<HWND>(window)); }
void closeEditorWindow(void* window) { DestroyWindow(static_cast<HWND>(window)); }
}
