// Deliberately bounded JSON Schema subset for explicit MCP adapters; unsupported constraints reject registration.
const supported=new Set(['type','properties','required','additionalProperties','items','enum','const','minimum','maximum','minLength','maxLength','minItems','maxItems','description','title','default','pattern'])
export function validateSchema(schema,depth=0){
 if(!schema || typeof schema!=='object' || Array.isArray(schema) || depth>12 || Object.keys(schema).some(k=>!supported.has(k)))throw Error('Unsupported MCP schema')
 if(!['object','array','string','number','integer','boolean','null'].includes(schema.type))throw Error('MCP schema requires a supported type')
 for(const child of Object.values(schema.properties||{}))validateSchema(child,depth+1)
 if(schema.items)validateSchema(schema.items,depth+1)
 if(schema.pattern){if(schema.pattern.length>200)throw Error('Pattern too long');new RegExp(schema.pattern)}
}
export function validateArguments(value,schema,depth=0){
 if(depth>20)throw Error('Arguments too deep')
 const type=schema.type, valid=type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='array'?Array.isArray(value):type==='integer'?Number.isSafeInteger(value):type==='null'?value===null:typeof value===type
 if(!valid)throw Error('Invalid argument type')
 if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))throw Error('Invalid argument enum')
 if(Object.hasOwn(schema,'const')&&JSON.stringify(value)!==JSON.stringify(schema.const))throw Error('Invalid argument constant')
 if(typeof value==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum)))throw Error('Argument out of range')
 if(typeof value==='string'&&((schema.minLength!==undefined&&value.length<schema.minLength)||(schema.maxLength!==undefined&&value.length>schema.maxLength)||(schema.pattern&&!new RegExp(schema.pattern).test(value))))throw Error('Invalid argument string')
 if(type==='object'){
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw Error('Missing required argument')
  for(const [key,item]of Object.entries(value)){const child=schema.properties?.[key];if(child)validateArguments(item,child,depth+1);else if(schema.additionalProperties===false)throw Error('Unknown argument')}
 }
 if(type==='array'){
  if((schema.minItems!==undefined&&value.length<schema.minItems)||(schema.maxItems!==undefined&&value.length>schema.maxItems))throw Error('Invalid array length')
  if(schema.items)for(const item of value)validateArguments(item,schema.items,depth+1)
 }
}
