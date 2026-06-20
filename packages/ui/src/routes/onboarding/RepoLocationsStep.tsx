import { useState } from "react";
import type { WireClient } from "../../wire/client";
import { FolderBrowser } from "./FolderBrowser";

export interface RepoLocationsStepProps {
  client: WireClient;
  initialRoots: string[];
  onBack: () => void;
  onFinish: (roots: string[]) => void;
}

/** Onboarding step 2: pick where your repos live, using the in-app folder browser.
    The chosen locations become the bridge's workspace roots (file reads are scoped to
    them) and the starting points of the Browse view. */
export function RepoLocationsStep({
  client,
  initialRoots,
  onBack,
  onFinish
}: Readonly<RepoLocationsStepProps>) {
  const [roots, setRoots] = useState<string[]>(initialRoots);

  const addRoots = (paths: string[]) => {
    setRoots((prev) => {
      const next = [...prev];
      for (const path of paths) {
        if (!next.includes(path)) {
          next.push(path);
        }
      }
      return next;
    });
  };
  const removeRoot = (path: string) => {
    setRoots((prev) => prev.filter((root) => root !== path));
  };

  return (
    <main className="onboarding">
      <div className="onboarding-card wide">
        <span className="brand-mark onboarding-mark" aria-hidden="true">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}icons/icon-512.svg`} alt="" />
        </span>
        <p className="eyebrow">Step 2 of 3</p>
        <h1 className="onboarding-title">Where do your repos live?</h1>
        <p className="onboarding-sub">
          Browse to a folder that holds your repos, or pick a VS Code{" "}
          <code> .code-workspace</code> file to add all the repos it references.
          HoneyHub lists what's inside and lets you read files (never edit). You can
          change this anytime in Settings.
        </p>

        <FolderBrowser client={client} onAddRoots={addRoots} />

        {roots.length > 0 && (
          <ul className="picked-roots" aria-label="Chosen locations">
            {roots.map((root) => (
              <li key={root}>
                <code>{root}</code>
                <button type="button" className="root-remove" onClick={() => removeRoot(root)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="onboarding-actions spread">
          <button type="button" className="onboarding-back" onClick={onBack}>
            Back
          </button>
          <button type="button" className="onboarding-continue" onClick={() => onFinish(roots)}>
            {roots.length > 0 ? "Finish" : "Skip for now"}
          </button>
        </div>
      </div>
    </main>
  );
}
