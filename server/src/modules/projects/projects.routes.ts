import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../../config.js';
import { projects } from '../../db/index.js';
import { asyncHandler, HttpError, validate } from '../../lib/http.js';
import { uploadTmpDir } from '../../lib/paths.js';
import type { ProjectOptions } from '../../types.js';
import { publicClip } from '../clips/clips.presenter.js';
import { publicGroupSummary, publicProject, publicProjectDetail, publicProjectListItem } from './projects.presenter.js';
import { createBatchSchema, createProjectSchema, pickClipsSchema } from './projects.schemas.js';
import { me } from '../auth/auth.middleware.js';
import * as service from './projects.service.js';

export const projectsRouter = Router();

fs.mkdirSync(uploadTmpDir, { recursive: true });
const upload = multer({
  dest: uploadTmpDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^video\//.test(file.mimetype) || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.originalname)),
});

projectsRouter.get('/projects', (req, res) => {
  res.json(projects.list(me(req).id).map(publicProjectListItem));
});

projectsRouter.post(
  '/projects',
  asyncHandler(async (req, res) => {
    const body = validate(createProjectSchema, req.body, 'Please paste a valid video link (https://…).');
    const p = await service.createFromLink(me(req), body.url, body.options as ProjectOptions);
    res.status(201).json(publicProject(p));
  }),
);

projectsRouter.post(
  '/projects/batch',
  asyncHandler(async (req, res) => {
    const body = validate(createBatchSchema, req.body, 'Check the links — each must be a full https:// link (up to 15 per project).');
    const { group, made, options } = await service.createFromLinks(me(req), body.urls, body.options as ProjectOptions);
    res.status(201).json({
      project: group ? publicGroupSummary(group) : publicProject(made[0]),
      projects: made.map((p) => publicProject(p)),
      understood: {
        minSeconds: options.minSeconds ?? null,
        maxSeconds: options.maxSeconds ?? null,
        tags: [...(options.requiredMentions ?? []), ...(options.requiredHashtags ?? [])],
        rules: options.rules ?? [],
      },
    });
  }),
);

projectsRouter.post(
  '/projects/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Please choose a video file (mp4, mov, mkv, webm).');
    const p = await service.createFromUpload(me(req), req.file, req.body.options);
    res.status(201).json(publicProject(p));
  }),
);

projectsRouter.get('/projects/:id', (req, res) => {
  res.json(publicProjectDetail(service.getProject(req.params.id, me(req))));
});

projectsRouter.post('/projects/:id/retry', (req, res) => {
  service.retryProject(req.params.id, me(req));
  res.json({ ok: true });
});

projectsRouter.delete(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    await service.deleteProject(req.params.id, me(req));
    res.json({ ok: true });
  }),
);

projectsRouter.post(
  '/projects/:id/clips',
  asyncHandler(async (req, res) => {
    const p = service.getProject(req.params.id, me(req));
    service.assertCanAddClips(p);
    const body = validate(pickClipsSchema, req.body, 'Select at least one part of the graph.');
    res.status(201).json((await service.addPickedClips(me(req), p, body.ranges, body.join)).map(publicClip));
  }),
);
