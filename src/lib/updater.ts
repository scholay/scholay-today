import { toast } from "../toast";

/** Upstream installers would overwrite this local build's customizations.
 * Updates require a reviewed rebuild until this customization is upstream. */
export async function checkForUpdates({ silent }: { silent: boolean }): Promise<void> {
  if (!silent) toast.show("本地定制版：上游自动更新已停用，升级需保留本地改造。");
}
