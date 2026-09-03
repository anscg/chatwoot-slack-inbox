import { setLogLevel } from "../src/logger.js";
import { setPostIntervalMs } from "../src/slack/post.js";

setLogLevel("error");
setPostIntervalMs(0);
