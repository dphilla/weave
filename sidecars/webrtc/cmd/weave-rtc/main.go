package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	rtcsidecar "github.com/dphilla/weave/sidecars/webrtc"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := rtcsidecar.Run(ctx, os.Stdin, os.Stdout); err != nil {
		var exitError *rtcsidecar.ExitError
		if errors.As(err, &exitError) {
			fmt.Fprintf(os.Stderr, "weave-rtc: %s\n", exitError.Code)
		} else {
			fmt.Fprintln(os.Stderr, "weave-rtc: internal sidecar failure")
		}
		os.Exit(1)
	}
}
