import {describe, expect, it} from 'vitest';
import {
  IMAGE_PROJECTION_MODEL_ENVIRONMENT_KEY,
  MCP_CLIENT_ENVIRONMENT_KEY,
  imageProjectionRenderOptions,
  resolveImageProjectionPxpipeModel,
} from '../../src/image_projection/render_profile.js';

describe('image projection render profile', () => {
  it('prefers an explicit pxpipe model over the MCP host', () => {
    expect(
      resolveImageProjectionPxpipeModel({
        [IMAGE_PROJECTION_MODEL_ENVIRONMENT_KEY]: 'gpt-5.6-sol',
        [MCP_CLIENT_ENVIRONMENT_KEY]: 'claude',
      }),
    ).toBe('gpt-5.6-sol');
  });

  it('maps the MCP host to a pxpipe profile when no model is set', () => {
    expect(resolveImageProjectionPxpipeModel({[MCP_CLIENT_ENVIRONMENT_KEY]: 'claude'})).toBe('claude-sonnet-4-6');
    expect(resolveImageProjectionPxpipeModel({[MCP_CLIENT_ENVIRONMENT_KEY]: 'codex'})).toBe('gpt-5.6-sol');
    expect(resolveImageProjectionPxpipeModel({[MCP_CLIENT_ENVIRONMENT_KEY]: 'cursor'})).toBe('grok-4.5');
    expect(resolveImageProjectionPxpipeModel({[MCP_CLIENT_ENVIRONMENT_KEY]: 'copilot'})).toBeUndefined();
    expect(
      imageProjectionRenderOptions(resolveImageProjectionPxpipeModel({[MCP_CLIENT_ENVIRONMENT_KEY]: 'copilot'})),
    ).toEqual(imageProjectionRenderOptions(undefined));
  });

  it('ignores unknown hosts and malformed model ids', () => {
    expect(resolveImageProjectionPxpipeModel({[MCP_CLIENT_ENVIRONMENT_KEY]: 'windsurf'})).toBeUndefined();
    expect(resolveImageProjectionPxpipeModel({[IMAGE_PROJECTION_MODEL_ENVIRONMENT_KEY]: 'grok 4.5'})).toBeUndefined();
    expect(resolveImageProjectionPxpipeModel({})).toBeUndefined();
  });

  it('passes a resolved model through to pxpipe and otherwise uses the readable strip', () => {
    expect(imageProjectionRenderOptions('grok-4.5')).toEqual({model: 'grok-4.5', reflow: true});
    expect(imageProjectionRenderOptions(undefined)).toMatchObject({
      cols: 84,
      reflow: true,
      style: {font: 'jetbrains-mono-14'},
    });
  });
});
