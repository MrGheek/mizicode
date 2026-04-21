import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profilesRouter from "./profiles";
import sessionsRouter from "./sessions";
import templatesRouter from "./templates";
import offersRouter from "./offers";
import dashboardRouter from "./dashboard";
import schedulerRouter from "./scheduler";
import memoryRouter from "./memory";
import skillsRouter from "./skills";
import repoRouter from "./repo";
import coordinationRouter from "./coordination";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profilesRouter);
router.use(sessionsRouter);
router.use(templatesRouter);
router.use(offersRouter);
router.use(dashboardRouter);
router.use(schedulerRouter);
router.use(memoryRouter);
router.use(skillsRouter);
router.use("/sessions/:sessionId/repo", repoRouter);
router.use(coordinationRouter);

export default router;
