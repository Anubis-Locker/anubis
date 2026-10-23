package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
)

type serviceHandler struct{ name string }

func (h serviceHandler) Execute(_ []string, changes <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	done := make(chan error, 1)
	status := svc.Status{State: svc.StartPending, WaitHint: 45000, CheckPoint: 1}
	statuses <- status
	go func() { done <- runHost(ctx, h.name, ready) }()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	readyCh := ready
	for {
		select {
		case <-readyCh:
			readyCh = nil
			if status.State != svc.StopPending {
				status = svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
				statuses <- status
			}
		case err := <-done:
			if err != nil {
				log.Printf("service failed: %v", err)
				events, eventErr := eventlog.Open(h.name)
				if eventErr != nil {
					log.Printf("event log open failed: %v", eventErr)
				} else {
					if eventErr := events.Error(1, err.Error()); eventErr != nil {
						log.Printf("event log write failed: %v", eventErr)
					}
					events.Close()
				}
				return true, 1
			}
			return false, 0
		case change, ok := <-changes:
			if !ok {
				cancel()
				changes = nil
				continue
			}
			switch change.Cmd {
			case svc.Interrogate:
				statuses <- status
			case svc.Stop, svc.Shutdown:
				status = svc.Status{State: svc.StopPending, WaitHint: 30000, CheckPoint: 1}
				statuses <- status
				cancel()
			}
		case <-tick.C:
			if status.State == svc.StartPending || status.State == svc.StopPending {
				status.CheckPoint++
				statuses <- status
			}
		}
	}
}

func runHost(ctx context.Context, name string, ready chan<- struct{}) error {
	if err := requireSystem(); err != nil {
		return err
	}
	c, err := loadConfig(name)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if !samePath(exe, filepath.Join(c.InstallDir, hostFile)) {
		return errors.New("host executable does not match protected installation")
	}
	if err := preparePrivileges(); err != nil {
		return err
	}
	root, err := dataDir(name)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(root, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	logger := log.New(file, "", log.Ldate|log.Ltime|log.LUTC)
	logger.Print("host starting")
	listener, err := listenBroker(name)
	if err != nil {
		logger.Printf("broker bind failed: %v", err)
		return err
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	b := &broker{config: c, logger: logger, contexts: make(map[string]*child)}
	defer b.stopContexts()
	machine, err := c.launch(ctx, true, nil)
	if err != nil {
		logger.Printf("machine startup failed: %v", err)
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer func() {
		if machine != nil {
			if err := machine.stop(); err != nil {
				logger.Printf("machine stop: %v", err)
			}
		}
	}()
	b.machine = machine
	logger.Printf("machine ready pid=%d sid=%s session=%d", machine.Info.Identity.PID, machine.Info.Identity.SID, machine.Info.Identity.SessionID)
	brokerDone := make(chan error, 1)
	go func() { brokerDone <- b.serve(ctx, listener) }()
	defer func() {
		cancel()
		listener.Close()
		<-brokerDone
	}()
	close(ready)
	failures := 0
	stableSince := time.Now()
	for {
		select {
		case <-ctx.Done():
			logger.Print("host stopping")
			return nil
		case err := <-brokerDone:
			// Put the result back for the shared shutdown join.
			brokerDone <- err
			if ctx.Err() != nil {
				return nil
			}
			if err == nil {
				return errors.New("broker listener stopped unexpectedly")
			}
			return fmt.Errorf("broker listener failed: %w", err)
		case <-machine.exit:
			logger.Printf("machine exited pid=%d code=%d waitError=%v", machine.Info.Identity.PID, machine.exitCode, machine.waitErr)
			b.mu.Lock()
			b.machine = nil
			b.mu.Unlock()
			machine.close()
			machine = nil
			if time.Since(stableSince) > 5*time.Minute {
				failures = 0
			}
			for machine == nil {
				failures++
				if failures > 5 {
					return errors.New("machine recovery exhausted five attempts; SCM recovery required")
				}
				delay := time.Second * time.Duration(1<<uint(failures-1))
				logger.Printf("machine recovery attempt=%d delay=%s", failures, delay)
				select {
				case <-ctx.Done():
					return nil
				case <-time.After(delay):
				}
				machine, err = c.launch(ctx, true, nil)
				if err != nil {
					logger.Printf("machine recovery failed: %v", err)
					if ctx.Err() != nil {
						return nil
					}
					continue
				}
				b.mu.Lock()
				b.machine = machine
				b.mu.Unlock()
				stableSince = time.Now()
				logger.Printf("machine recovered pid=%d", machine.Info.Identity.PID)
			}
		}
	}
}
