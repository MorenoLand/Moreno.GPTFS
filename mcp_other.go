//go:build !windows

package main

func killMCPs(q Req) Res { return Res{Error: "kill_mcps is only supported on Windows"} }
