import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profilesRouter from "./profiles";
import sessionsRouter from "./sessions";
import templatesRouter from "./templates";
import offersRouter from "./offers";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profilesRouter);
router.use(sessionsRouter);
router.use(templatesRouter);
router.use(offersRouter);
router.use(dashboardRouter);

export default router;
