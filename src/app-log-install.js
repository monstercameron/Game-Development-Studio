// Side-effect module imported once by src/main.jsx: turns on automatic browser log capture
// (route changes, failed /api requests, named button clicks). See src/app-log.js.
import { installAppLogCapture } from './app-log.js';

installAppLogCapture();
