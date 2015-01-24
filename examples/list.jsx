
/** @jsx React.DOM */

var ObjectEntry = React.createClass({
    del: function(name) {
        this.props.onDel(name);
    },
	render: function() {
		return <tr key={this.props.data.hash}>
        <td>{this.props.data.name}</td>
        <td>{this.props.data.content_type}</td>
        <td>{this.props.data.bytes}</td>
        <td>
            <button onClick={this.del.bind(this, this.props.data.name)}>Delete</button>
        </td>
        </tr>
	}
});

var ObjectList = React.createClass({
    getInitialState: function() {
        return {
            objects: []
        }
    },
    delObject: function(name) {
        client.delObject(this.props.container, name).then(function(){
            client.listObjects(this.props.container).then(function(result) {
                this.setState({objects: result});
            }.bind(this));
        }.bind(this));
    },
    componentWillUpdate: function(props) {
        if (props.container && props.container !== this.props.container) {
            client.listObjects(props.container).then(function(result) {
                this.setState({objects: result});
            }.bind(this));
        }
    },
    render: function() {
        return <table>
        {this.state.objects.map(function(object) {
            return <ObjectEntry data={object} onDel={this.delObject.bind(this)} ></ObjectEntry>
        }.bind(this))}
        </table>
    }
});

var ContainerSelect = React.createClass({
    onChange: function(e) {
        this.props.onChange(e.target.value);
    },
    render: function() {
        return <select onChange={this.onChange.bind(this)}>
        {this.props.data.map(function(item) {
            return <option key={item.name} value={item.name} >{item.name}</option>
        }.bind(this))}
        </select>
    }
});

var App = React.createClass({
    getInitialState: function() {
        return {
            containers: [],
            container: null,
        }
    },
    componentDidMount: function() {
        client.listContainers().then(function(result) {
            this.setState({containers: result});
        }.bind(this));
    },
    changeContainer: function(container) {
        this.setState({container: container})
    },
    render: function() {
        return <div>
        <ContainerSelect data={this.state.containers} onChange={this.changeContainer.bind(this)} />
        <ObjectList container={this.state.container} />
        </div>
    }
});
