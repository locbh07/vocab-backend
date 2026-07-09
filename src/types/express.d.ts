import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    isPremium?: boolean;
    premiumUserId?: number | null;
  }
}
