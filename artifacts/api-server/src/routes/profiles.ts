import { Router } from "express";
import { getAllProfiles, getProfileById } from "../services/profiles";

const router = Router();

router.get("/profiles", async (_req, res) => {
  const profiles = await getAllProfiles();
  res.json(profiles);
});

router.get("/profiles/:profileId", async (req, res) => {
  const id = parseInt(req.params.profileId);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid profile ID" });
    return;
  }
  const profile = await getProfileById(id);
  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json(profile);
});

export default router;
