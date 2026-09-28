import initial from "./yearOfficialSeeds.json";
import humanities from "./yearOfficialHumanitiesSeeds.json";
import arts from "./yearOfficialArtsSeeds.json";
import artsFund from "./yearOfficialArtsFundSeeds.json";
import castTalent from "./yearOfficialCastTalentSeeds.json";
import cscTalent from "./yearOfficialCscTalentSeeds.json";
import educationPlanning from "./yearOfficialEducationPlanningSeeds.json";
import internationalTalent from "./yearOfficialInternationalTalentSeeds.json";
import moe from "./yearOfficialMoeSeeds.json";
import national from "./yearOfficialNationalSeeds.json";
import postdocHistory from "./yearOfficialPostdocHistorySeeds.json";
import recurring from "./yearOfficialRecurringSeeds.json";
import talent from "./yearOfficialTalentSeeds.json";
import youthFund from "./yearOfficialYouthFundSeeds.json";
import nsfcGrowth from "./yearOfficialNsfcGrowthSeeds.json";
import campus from "./yearOfficialCampusSeeds.json";
import conferenceBodies from "./yearOfficialConferenceBodySeeds.json";
import { attachOfficialBodyCache } from "./yearOfficialBodyCache";
import type { GrowSeed } from "./yearGrow";

/**
 * Reviewed official notices are stored in small, source-focused batches so
 * they can grow without making a single hand-maintained file unreviewable.
 */
const sourceSeeds: readonly GrowSeed[] = [
  ...(initial as GrowSeed[]),
  ...(national as GrowSeed[]),
  ...(talent as GrowSeed[]),
  ...(humanities as GrowSeed[]),
  ...(moe as GrowSeed[]),
  ...(postdocHistory as GrowSeed[]),
  ...(educationPlanning as GrowSeed[]),
  ...(internationalTalent as GrowSeed[]),
  ...(arts as GrowSeed[]),
  ...(recurring as GrowSeed[]),
  ...(artsFund as GrowSeed[]),
  ...(youthFund as GrowSeed[]),
  ...(nsfcGrowth as GrowSeed[]),
  ...(conferenceBodies as GrowSeed[]),
  ...(castTalent as GrowSeed[]),
  ...(cscTalent as GrowSeed[]),
  ...(campus as GrowSeed[]),
];

export const yearOfficialSeeds: readonly GrowSeed[] = attachOfficialBodyCache(sourceSeeds);
