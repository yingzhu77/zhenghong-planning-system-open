export class HttpError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicError(error) {
  if (error instanceof HttpError) return { status: error.status, error: { code: error.code, message: error.message } };
  const mapped = {
    '42501': [403, '没有执行此操作的权限'],
    '23505': [409, '记录已存在，请刷新后重试'],
    '23503': [400, '关联的项目或成员不存在'],
    '23502': [400, '缺少必填字段'],
    '23514': [400, '数据不符合业务规则'],
    '22P02': [400, '字段格式不正确'],
    '22007': [400, '日期格式不正确'],
    '22008': [400, '日期超出有效范围'],
    '22021': [400, '文本包含不支持的字符'],
    '40001': [409, '数据已被其他操作更新，请刷新后重试']
  };
  const match = mapped[error?.code];
  if (match) return { status: match[0], error: { code: error.code, message: match[1] } };
  if (error?.type === 'entity.too.large') return { status: 413, error: { code: 'too_large', message: '请求内容过大' } };
  if (error?.type === 'entity.parse.failed') return { status: 400, error: { code: 'invalid_json', message: '请求内容不是有效的JSON' } };
  return { status: 500, error: { code: 'internal_error', message: '服务处理失败，请稍后重试' } };
}
