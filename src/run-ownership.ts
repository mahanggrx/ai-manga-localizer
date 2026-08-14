import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalizerError } from "./errors.ts";
import { assertPathInside } from "./file-utils.ts";
import { jsonSha256 } from "./scene-integrity.ts";
import type { JsonObject, JsonValue, KoharuProjectIdentity, KoharuProjectsSnapshot, KoharuSceneSnapshot } from "./types.ts";

export interface ProjectListClient {
  listProjects(): Promise<KoharuProjectsSnapshot>;
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function projectIdFromScene(scene: JsonObject): string | undefined {
  if (typeof scene.projectId === "string") return scene.projectId;
  const project = object(scene.project);
  return project && typeof project.id === "string" ? project.id : undefined;
}

function maskTextFields(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) maskTextFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const kind = object(value.kind);
  const text = object(kind?.text);
  if (text) {
    text.text = "__OWNED_PROJECT_SOURCE_TEXT__";
    text.translation = "__OWNED_PROJECT_TRANSLATION__";
  }
  for (const child of Object.values(value)) maskTextFields(child);
}

export function ownedSceneIdentityHash(snapshot: KoharuSceneSnapshot): string {
  const scene = structuredClone(snapshot.scene);
  maskTextFields(scene);
  return jsonSha256(scene);
}

export class OwnedProjectGuard {
  private readonly client: ProjectListClient;
  private readonly project: KoharuProjectIdentity;
  private readonly projectsRoot: string;
  private readonly assertProcess: () => Promise<void>;
  private sceneIdentityHash?: string;

  constructor(options: {
    client: ProjectListClient;
    project: KoharuProjectIdentity;
    projectsRoot: string;
    assertProcess: () => Promise<void>;
  }) {
    this.client = options.client;
    this.project = options.project;
    this.projectsRoot = path.resolve(options.projectsRoot);
    this.assertProcess = options.assertProcess;
  }

  async assertIdentity(): Promise<void> {
    await this.assertProcess();
  }

  async assertProjectIdentity(snapshot?: KoharuSceneSnapshot): Promise<void> {
    await this.assertProcess();
    const listed = await this.client.listProjects();
    if (listed.projects.length !== 1 || listed.projects[0].id !== this.project.id) {
      throw new LocalizerError("OWNED_KOHARU_PROJECT_DRIFT", "Owned Koharu data root must contain exactly the project created by this run");
    }
    const listedProject = listed.projects[0];
    if (listedProject.path !== undefined) assertPathInside(this.projectsRoot, path.resolve(listedProject.path));
    if (this.project.path !== undefined && listedProject.path !== undefined && path.resolve(this.project.path) !== path.resolve(listedProject.path)) {
      throw new LocalizerError("OWNED_KOHARU_PROJECT_DRIFT", "Owned Koharu project path changed");
    }
    if (snapshot) {
      const sceneProjectId = projectIdFromScene(snapshot.scene);
      if (sceneProjectId !== undefined && sceneProjectId !== this.project.id) throw new LocalizerError("OWNED_KOHARU_ACTIVE_PROJECT_DRIFT", "Scene belongs to a different active project");
      if (this.sceneIdentityHash !== undefined && ownedSceneIdentityHash(snapshot) !== this.sceneIdentityHash) {
        throw new LocalizerError("OWNED_KOHARU_SCENE_IDENTITY_DRIFT", "Owned scene population, geometry, mask/blob reference, or unknown field changed");
      }
    }
  }

  async establishSceneIdentity(snapshot: KoharuSceneSnapshot, identityFile?: string): Promise<string> {
    await this.assertProjectIdentity(snapshot);
    if (this.sceneIdentityHash !== undefined) throw new LocalizerError("OWNED_KOHARU_SCENE_IDENTITY_ALREADY_SET", "Owned scene identity can only be established once");
    this.sceneIdentityHash = ownedSceneIdentityHash(snapshot);
    if (identityFile) {
      await writeFile(identityFile, `${JSON.stringify({
        schemaVersion: 1,
        projectId: this.project.id,
        sceneIdentityHash: this.sceneIdentityHash,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    return this.sceneIdentityHash;
  }
}
