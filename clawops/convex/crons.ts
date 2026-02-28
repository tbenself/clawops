import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sweep", { minutes: 2 }, internal.sweeper.sweep);

export default crons;
