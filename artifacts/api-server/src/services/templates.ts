import { db, templatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as vastai from "./vastai";
import { logger } from "../lib/logger";

const DEFAULT_TEMPLATE_NAME = "OmniQL Coding Environment";
const DEFAULT_IMAGE = "gheeklabs/coding-env:cuda12.4";

const DEFAULT_ONSTART = `#!/bin/bash
# OmniQL Coding Environment - parameterized via env vars
# MODEL_REPO, MODEL_QUANT, LLAMA_CTX_SIZE, LLAMA_BATCH_SIZE, LLAMA_EXTRA_ARGS
/opt/onstart.sh
`;

const DEFAULT_ENV_VARS = [
  "MODEL_REPO=unsloth/Kimi-K2.6-GGUF",
  "MODEL_QUANT=UD-TQ1_0",
  "LLAMA_CTX_SIZE=32768",
  "LLAMA_BATCH_SIZE=512",
].join("\n");

export async function registerDefaultTemplate(): Promise<void> {
  const [existing] = await db
    .select()
    .from(templatesTable)
    .where(eq(templatesTable.isDefault, true))
    .limit(1);

  if (existing) {
    logger.info({ templateId: existing.id, templateHash: existing.templateHash }, "Default template already registered");
    return;
  }

  logger.info("Registering default OmniQL template on Vast.ai...");

  try {
    const vastResult = await vastai.createTemplate({
      name: DEFAULT_TEMPLATE_NAME,
      image_tag: DEFAULT_IMAGE,
      onstart: DEFAULT_ONSTART,
      env: DEFAULT_ENV_VARS,
      disk_space: 400,
      readme: "OmniQL Cloud Coding environment with llama.cpp (Kimi K2.6), code-server, and Bolt.diy",
    });

    const templateHash = vastResult.template?.hash_id || vastResult.template_hash || vastResult.hash_id || "";

    await db.insert(templatesTable).values({
      templateHash,
      name: DEFAULT_TEMPLATE_NAME,
      image: DEFAULT_IMAGE,
      onStartScript: DEFAULT_ONSTART,
      envVars: DEFAULT_ENV_VARS,
      isDefault: true,
      diskSpace: 400,
    });

    logger.info({ templateHash }, "Default template registered on Vast.ai and stored in DB");
  } catch (err) {
    logger.error(err, "Failed to register default template on Vast.ai — sessions will use direct image launch");
  }
}
