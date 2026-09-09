import server
print(server.app.url_map)
for rule in server.app.url_map.iter_rules():
    print(rule.rule, list(rule.methods))
