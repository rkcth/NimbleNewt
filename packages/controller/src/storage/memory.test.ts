import { runStorageConformance } from "./conformance.js";
import { MemoryStorage } from "./memory.js";

runStorageConformance({ name: "MemoryStorage", open: async () => ({ storage: new MemoryStorage() }) });
