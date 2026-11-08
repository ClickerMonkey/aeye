import { folderConverter, parseFolderListing } from "../converters/folder";
import type { ResourceLink } from "../types";
import { createLinkId, dedupeLinks } from "../utils";
import { createVersionParser } from "./version";

/** Folders, through their markdown listing; every entry is a link, so a resource graph walks the tree. */
export const folderParser = createVersionParser({
  id: "folder-parser",
  supportedTypes: ["folder"],
  defaultSlicer: "markdown",
  fallback: folderConverter,
  links: ({ raw, location }) => {
    return dedupeLinks(parseFolderListing(raw).entries.map((entry, i): ResourceLink => ({
      id: createLinkId(location, entry.location, i),
      value: entry.location,
      location,
      kind: "resource",
      title: entry.name,
      ...(entry.type !== undefined ? { targetType: entry.type } : {}),
    })));
  },
});
