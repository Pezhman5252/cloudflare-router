import { createFetchHandler, ApiKeyCoordinator } from "../../../common/provider-core.js";

export { ApiKeyCoordinator };

// تنظیمات خاص BAI (در صورت نیاز)
const customConfig = {
  // timeout: 120000,
  // maxAttempts: 3,
};

export default {
  fetch: createFetchHandler(customConfig)
};