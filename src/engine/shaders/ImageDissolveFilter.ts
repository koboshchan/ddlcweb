import { Filter, GlProgram, Texture } from "pixi.js";

const VERTEX_SHADER = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

const FRAGMENT_SHADER = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uMask;
uniform float uProgress;
uniform float uRamp;
uniform float uReverse;

void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  float maskVal = texture(uMask, vTextureCoord).r;
  if (uReverse > 0.5) {
    maskVal = 1.0 - maskVal;
  }

  float ramp = max(uRamp, 0.001);
  float factor = clamp((uProgress * (1.0 + ramp) + maskVal - 1.0) / ramp, 0.0, 1.0);
  finalColor = src * factor;
}
`;

/**
 * PixiJS v8 GLSL filter replicating Ren'Py's `ImageDissolve(image, time, ramplen)`
 * transition (used by DDLC's `wipeleft`, `wipeleft_scene`, `dissolve_cg`, etc.).
 */
export class ImageDissolveFilter extends Filter {
  public constructor(maskTexture: Texture, rampFraction = 0.25, reverse = false) {
    const glProgram = new GlProgram({
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
      name: "ddlc-image-dissolve",
    });

    super({
      glProgram,
      resources: {
        uMask: maskTexture.source,
        dissolveUniforms: {
          uProgress: { value: 0, type: "f32" },
          uRamp: { value: rampFraction, type: "f32" },
          uReverse: { value: reverse ? 1 : 0, type: "f32" },
        },
      },
    });
  }

  public get progress(): number {
    return this.resources.dissolveUniforms.uniforms.uProgress as number;
  }

  public set progress(value: number) {
    this.resources.dissolveUniforms.uniforms.uProgress = value;
  }
}
