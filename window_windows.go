//go:build windows

package main

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var roundedWindows sync.Map

func roundWindowsWindow(hwnd uintptr, _ uint32, _, _ uintptr) (uintptr, bool) {
	if _, loaded := roundedWindows.LoadOrStore(hwnd, struct{}{}); !loaded {
		preference := uint32(2)
		_ = windows.DwmSetWindowAttribute(windows.HWND(hwnd), windows.DWMWA_WINDOW_CORNER_PREFERENCE, unsafe.Pointer(&preference), uint32(unsafe.Sizeof(preference)))
	}
	return 0, false
}
