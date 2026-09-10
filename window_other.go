//go:build !windows

package main

func roundWindowsWindow(uintptr, uint32, uintptr, uintptr) (uintptr, bool) { return 0, false }
