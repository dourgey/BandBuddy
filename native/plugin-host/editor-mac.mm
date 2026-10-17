#include "node.h"
#include "pluginterfaces/gui/iplugview.h"
#import <Cocoa/Cocoa.h>
namespace bb::plugins {
using namespace Steinberg;
void initializePlatform() { [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]; [NSApp finishLaunching]; }
void pumpPlatform() {
  @autoreleasepool {
    NSEvent* event;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantPast] inMode:NSDefaultRunLoopMode dequeue:YES])) [NSApp sendEvent:event];
    [NSApp updateWindows];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true);
  }
}
void resizeEditorWindow(void* window, int width, int height) { [(NSWindow*)window setContentSize:NSMakeSize(width, height)]; }
void* openEditorWindow(void* pointer, const std::string& title) {
  auto* view = static_cast<IPlugView*>(pointer);
  if (view->isPlatformTypeSupported(kPlatformTypeNSView) != kResultTrue) return nullptr;
  ViewRect rect{0, 0, 640, 480}; view->getSize(&rect);
  NSWindow* window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, rect.getWidth(), rect.getHeight())
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
  [window setReleasedWhenClosed:NO]; [window setTitle:[NSString stringWithUTF8String:title.c_str()]];
  if (view->attached([window contentView], kPlatformTypeNSView) != kResultTrue) { [window release]; return nullptr; }
  [window center]; [window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; return window;
}
void showEditorWindow(void* window) { [(NSWindow*)window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; }
void closeEditorWindow(void* window) { [(NSWindow*)window close]; [(NSWindow*)window release]; }
}
