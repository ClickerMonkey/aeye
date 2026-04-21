1. [x] Loop validate if concurrent returns expected number types - also the scope types should not be any but the key/value types
2. [x] Change all inline imports to top-level imports
3. [x] Problems.at error: Argument of type '(string | number)[]' is not assignable to parameter of type 'string | number'.
4. [x] IfExpr should use traversing function to determine hasFlow - looking for direct child does not work. It should be more nuanced and also look for the type of flows that matter for toCode
5. [x] native.ts line 30 error, impl does not expect engine.registry
6. [x] NewExpr.toCode should handle if value === undefined and the type is optional
7. [x] add `static toSchema(schemaOptions: {Type: ZodType, Expr: ZodType}): z.ZodType` to Node & every Type & Expr. This is so I can pass schemas of all types and Exprs to an LLM and ask for a program it will work. The schemas will match the Defs interfaces but for types the options should have an options schema. A "Type" would be all of the types unioned. An "Expr" would be all the exprs. Those are special! You can make a static version of this function.
8. [x] make sure the user can build a custom "Person" type that is an object with a `fullName` prop which is a function that concats the firstName and lastName (uses template expr) and then once that's added to the registry you can make a little program that news a person, sets the names, and returns the fullName. Make this a unit test!
