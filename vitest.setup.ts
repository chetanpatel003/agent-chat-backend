import "dotenv/config";

// No test may ever reach the real Backblaze B2 bucket: force a fake
// configuration on a reserved .test host that cannot resolve. Tests that
// exercise B2 mock this endpoint with MSW.
process.env.B2_KEY_ID = "0050000000000000000000001";
process.env.B2_APPLICATION_KEY = "K005FAKEAPPLICATIONKEYSECRETVAL";
process.env.B2_BUCKET_NAME = "agentChat";
process.env.B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.test";
process.env.B2_REGION = "us-east-005";
