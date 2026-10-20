export { OVERRIDE_ENV, OVERRIDE_FLAG, SUPPORTED_ENVIRONMENT, type PlatformSupport } from "./supported.js";
export {
  UnsupportedEnvironmentError, checkEnvironment, compareVersions, detectEnvironment, overrideRequested, refusalMessage, startupCheck,
  type EnvironmentFacts, type Problem, type StartupCheck,
} from "./check.js";
export { recordOverride } from "./startup.js";
