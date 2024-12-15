import { glsl } from '../../../shader/util';

export default glsl`
// TODO move to math utils
mat2 vector_to_rotation_matrix(vec2 vector)
{
  float cos_angle = vector.x;
  float sin_angle = vector.y;
  return mat2(cos_angle, sin_angle, -sin_angle, cos_angle);
}

mat3 euler_to_mat3(vec3 euler)
{
  float cx = cos(euler.x);
  float cy = cos(euler.y);
  float cz = cos(euler.z);
  float sx = sin(euler.x);
  float sy = sin(euler.y);
  float sz = sin(euler.z);

  mat3 mat;
  mat[0][0] = cy * cz;
  mat[0][1] = cy * sz;
  mat[0][2] = -sy;

  mat[1][0] = sy * sx * cz - cx * sz;
  mat[1][1] = sy * sx * sz + cx * cz;
  mat[1][2] = cy * sx;

  mat[2][0] = sy * cx * cz + sx * sz;
  mat[2][1] = sy * cx * sz - sx * cz;
  mat[2][2] = cy * cx;
  return mat;
}

vec3 rotate_around_axis(vec3 p, vec3 axis, float angle)
{
  float costheta = cos(angle);
  float sintheta = sin(angle);
  vec3 r;

  r.x = ((costheta + (1.0 - costheta) * axis.x * axis.x) * p.x) +
        (((1.0 - costheta) * axis.x * axis.y - axis.z * sintheta) * p.y) +
        (((1.0 - costheta) * axis.x * axis.z + axis.y * sintheta) * p.z);

  r.y = (((1.0 - costheta) * axis.x * axis.y + axis.z * sintheta) * p.x) +
        ((costheta + (1.0 - costheta) * axis.y * axis.y) * p.y) +
        (((1.0 - costheta) * axis.y * axis.z - axis.x * sintheta) * p.z);

  r.z = (((1.0 - costheta) * axis.x * axis.z - axis.y * sintheta) * p.x) +
        (((1.0 - costheta) * axis.y * axis.z + axis.x * sintheta) * p.y) +
        ((costheta + (1.0 - costheta) * axis.z * axis.z) * p.z);

  return r;
}

void node_vector_rotate_axis_angle(
    vec3 vector_in, vec3 center, vec3 axis, float angle, vec3 rotation, float invert, out vec3 vec)
{
  vec = (length(axis) != 0.0) ?
            rotate_around_axis(vector_in - center, normalize(axis), angle * invert) + center :
            vector_in;
}

void node_vector_rotate_axis_x(
    vec3 vector_in, vec3 center, vec3 axis, float angle, vec3 rotation, float invert, out vec3 vec)
{
  vec = rotate_around_axis(vector_in - center, vec3(1.0, 0.0, 0.0), angle * invert) + center;
}

void node_vector_rotate_axis_y(
    vec3 vector_in, vec3 center, vec3 axis, float angle, vec3 rotation, float invert, out vec3 vec)
{
  vec = rotate_around_axis(vector_in - center, vec3(0.0, 1.0, 0.0), angle * invert) + center;
}

void node_vector_rotate_axis_z(
    vec3 vector_in, vec3 center, vec3 axis, float angle, vec3 rotation, float invert, out vec3 vec)
{
  vec = rotate_around_axis(vector_in - center, vec3(0.0, 0.0, 1.0), angle * invert) + center;
}

void node_vector_rotate_euler_xyz(
    vec3 vector_in, vec3 center, vec3 axis, float angle, vec3 rotation, float invert, out vec3 vec)
{
  mat3 rmat = (invert < 0.0) ? transpose(euler_to_mat3(rotation)) : euler_to_mat3(rotation);
  vec = rmat * (vector_in - center) + center;
}`;
