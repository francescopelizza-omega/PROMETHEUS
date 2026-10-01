#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/** cli.tsx — entry point: render the Prometheus TUI fullscreen. */
import React from "react";
import { render } from "ink";
import App from "./App.js";

const { waitUntilExit } = render(<App />);
waitUntilExit().then(() => process.exit(0));
