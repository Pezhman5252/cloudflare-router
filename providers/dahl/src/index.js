import { createFetchHandler, ApiKeyCoordinator } from "../../../common/provider-core.js";

export { ApiKeyCoordinator };

// تنظیمات خاص Dahl (در صورت نیاز)
const customConfig = {
  // timeout: 240000,
  // maxAttempts: 5,
};

export default {
  fetch: createFetchHandler(customConfig)
};