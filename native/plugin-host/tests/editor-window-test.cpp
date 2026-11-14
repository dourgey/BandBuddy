#include "node.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include <windows.h>
#include <cstring>
#include <iostream>

using namespace Steinberg;
using namespace bb::plugins;
class View final : public U::Implements<U::Directly<IPlugView, IPlugViewContentScaleSupport>> {
 public:
  void** published = nullptr;
  bool publishedDuringAttach = false;
  int sizeCalls = 0;
  float scale = 1;
  ViewRect size{0, 0, 720, 420};
  tresult PLUGIN_API setContentScaleFactor(float value) override { scale = value; size = {0, 0, int32(720 * value), int32(420 * value)}; return kResultOk; }
  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) override { return std::strcmp(type, kPlatformTypeHWND) == 0 ? kResultTrue : kResultFalse; }
  tresult PLUGIN_API attached(void* window, FIDString) override {
    publishedDuringAttach = published && *published == window;
    // Editors may settle on a different size during attachment.
    size.right += 120; size.bottom += 80;
    if (publishedDuringAttach) resizeEditorWindow(*published, size.getWidth(), size.getHeight());
    return kResultOk;
  }
  tresult PLUGIN_API removed() override { return kResultOk; }
  tresult PLUGIN_API onWheel(float) override { return kResultFalse; }
  tresult PLUGIN_API onKeyDown(char16, int16, int16) override { return kResultFalse; }
  tresult PLUGIN_API onKeyUp(char16, int16, int16) override { return kResultFalse; }
  tresult PLUGIN_API getSize(ViewRect* rect) override { *rect = size; return kResultOk; }
  tresult PLUGIN_API onSize(ViewRect* rect) override { size = *rect; ++sizeCalls; return kResultOk; }
  tresult PLUGIN_API onFocus(TBool) override { return kResultOk; }
  tresult PLUGIN_API setFrame(IPlugFrame*) override { return kResultOk; }
  tresult PLUGIN_API canResize() override { return kResultFalse; }
  tresult PLUGIN_API checkSizeConstraint(ViewRect*) override { return kResultOk; }
};
int main() {
  initializePlatform();
  View view;
  void* published = nullptr; view.published = &published;
  const auto window = static_cast<HWND>(openEditorWindow(static_cast<IPlugView*>(&view), "BandBuddy editor test", &published));
  if (!window) return 2;
  pumpPlatform();
  const bool firstOpenVisible = IsWindowVisible(window);
  RECT client{}; GetClientRect(window, &client);
  const bool initialSize = client.right == view.size.getWidth() && client.bottom == view.size.getHeight() && view.sizeCalls > 0 && view.publishedDuringAttach;
  RECT bounds{}; GetWindowRect(window, &bounds);
  SendMessageW(window, WM_DPICHANGED, MAKELONG(144, 144), reinterpret_cast<LPARAM>(&bounds));
  GetClientRect(window, &client);
  const bool dpiResize = view.scale == 1.5f && client.right == 1080 && client.bottom == 630;
  SendMessageW(window, WM_CLOSE, 0, 0);
  const bool closeHides = !IsWindowVisible(window) && IsWindow(window);
  showEditorWindow(window); pumpPlatform();
  const bool reopenVisible = IsWindowVisible(window);
  closeEditorWindow(window);
  const bool destroyed = !IsWindow(window);
  const bool passed = firstOpenVisible && closeHides && reopenVisible && destroyed && initialSize && dpiResize;
  std::cout << json({{"passed", passed}, {"firstOpenVisible", firstOpenVisible}, {"closeHides", closeHides},
    {"reopenVisible", reopenVisible}, {"destroyed", destroyed}, {"initialSize", initialSize}, {"dpiResize", dpiResize}, {"width", client.right}, {"height", client.bottom}}).dump() << std::endl;
  return passed ? 0 : 1;
}
